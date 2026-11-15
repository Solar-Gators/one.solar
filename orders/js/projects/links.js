/**
 * Projects: Smart Links. A document is linked by pasting its address; the file stays in Teams / SharePoint /
 * OneDrive (or GitHub, a CAD system, another one.solar app…) and that system keeps deciding who can open it.
 *
 * recognise() only reads the address. It never fetches anything, so it can't tell (and never claims) whether
 * the file exists or who may open it. No Microsoft Graph, app registration or sign-in is involved; pm_resources
 * has a `meta` column for a later Graph sync without changing what's stored here.
 */

const EXT = {
  docx: 'Word', doc: 'Word', xlsx: 'Excel', xlsm: 'Excel', xls: 'Excel', csv: 'Spreadsheet', pptx: 'PowerPoint', ppt: 'PowerPoint', pdf: 'PDF',
  sldprt: 'SolidWorks part', sldasm: 'SolidWorks assembly', slddrw: 'SolidWorks drawing', step: 'STEP', stp: 'STEP', iges: 'IGES', igs: 'IGES', stl: 'STL',
  dxf: 'DXF', dwg: 'DWG', ipt: 'Inventor part', iam: 'Inventor assembly', f3d: 'Fusion', kicad_pcb: 'KiCad board', kicad_sch: 'KiCad schematic', sch: 'Schematic',
  brd: 'Board', png: 'Image', jpg: 'Image', jpeg: 'Image', svg: 'Image', mp4: 'Video', mov: 'Video', zip: 'Archive', txt: 'Text', md: 'Text', m: 'MATLAB',
  mat: 'MATLAB data', py: 'Python', ipynb: 'Notebook', one: 'OneNote',
};
/** The letter SharePoint puts in a sharing link: /:x:/ is Excel, /:f:/ a folder… */
const SP_KIND = { x: 'xlsx', w: 'docx', p: 'pptx', b: 'pdf', o: 'one', v: 'mp4', i: 'png', t: 'txt' };

export const PROVIDERS = {
  sharepoint: 'SharePoint', teams: 'Teams', onedrive: 'OneDrive', github: 'GitHub', google: 'Google Drive', onshape: 'Onshape', grabcad: 'GrabCAD',
  onesolar: 'one.solar', link: 'Link',
};

/** An icon for a linked document (emoji, so nothing is loaded). */
export function resourceIcon(r) {
  if (r.kind === 'folder') return '📁';
  if (r.kind === 'repo') return '🧬';
  const t = (r.file_type || '').toLowerCase();
  if (['xlsx', 'xlsm', 'xls', 'csv'].includes(t)) return '📊';
  if (['docx', 'doc', 'txt', 'md', 'one'].includes(t)) return '📝';
  if (['pptx', 'ppt'].includes(t)) return '📽️';
  if (t === 'pdf') return '📕';
  if (['sldprt', 'sldasm', 'slddrw', 'step', 'stp', 'iges', 'igs', 'stl', 'dxf', 'dwg', 'ipt', 'iam', 'f3d'].includes(t)) return '📐';
  if (['png', 'jpg', 'jpeg', 'svg'].includes(t)) return '🖼️';
  if (['mp4', 'mov'].includes(t)) return '🎞️';
  if (['m', 'mat', 'py', 'ipynb'].includes(t)) return '🧮';
  return r.kind === 'page' ? '🔗' : '📄';
}
export const fileTypeLabel = (t) => EXT[(t || '').toLowerCase()] || (t ? t.toUpperCase() : '');

const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};
const extOf = (name) => (/\.([A-Za-z0-9_]{1,10})$/.exec(name || '')?.[1] || '').toLowerCase();
const tidy = (name) => decode(name || '').replace(/\+/g, ' ').replace(/\.[A-Za-z0-9_]{1,10}$/, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Read a pasted address.
 * → { ok: false, error } or { ok: true, url, provider, kind: file | folder | page | repo, file_type, title, note }
 * `note` is advice about sharing (never a claim about access).
 */
export function recognise(input, { siteUrl = '' } = {}) {
  const raw = String(input || '').trim();
  if (!raw) return { ok: false, error: 'Paste the link first.' };
  if (/\s/.test(raw)) return { ok: false, error: 'That doesn\'t look like one link (it has spaces in it). Use "Copy link" in Teams and paste it here.' };
  let u;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, error: 'That isn\'t a full link. It should start with https://' };
  }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// links can be saved.' };
  if (/[<>"]/.test(raw)) return { ok: false, error: 'That link has characters a web address can\'t have.' };
  if (u.username || u.password) return { ok: false, error: 'That link has a user name or password in it. Copy the link again without them.' };
  if (raw.length > 2000) return { ok: false, error: 'That link is too long to save.' };

  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split('/').filter(Boolean).map(decode);
  const last = segs.at(-1) || '';
  const out = { ok: true, url: u.href, provider: 'link', kind: 'page', file_type: '', title: '', note: '' };

  if (host.endsWith('.sharepoint.com') || host === 'sharepoint.com') {
    out.provider = host.includes('-my.') ? 'onedrive' : 'sharepoint';
    const share = /^:([a-z]):$/.exec(segs[0] || '');
    const idPath = decode(u.searchParams.get('id') || u.searchParams.get('RootFolder') || '');
    if (share) {
      out.kind = share[1] === 'f' ? 'folder' : 'file';
      out.file_type = extOf(last) || SP_KIND[share[1]] || '';
      // /:x:/r/sites/… keeps existing access; /:x:/s/… or /:x:/g/… is a sharing link someone made
      if (segs[1] !== 'r') out.note = 'This looks like a sharing link. If it was made for "Anyone with the link", it lets anyone in who gets hold of it. In Teams or SharePoint, "Copy link" → "People with existing access" keeps the file\'s own permissions.';
    } else if (idPath) {
      out.kind = extOf(idPath) ? 'file' : 'folder';
      out.file_type = extOf(idPath);
    } else if (/\.aspx$/i.test(last)) {
      out.kind = /AllItems|Forms/i.test(u.pathname) ? 'folder' : 'page';
    } else {
      out.kind = extOf(last) ? 'file' : 'folder';
      out.file_type = extOf(last);
    }
    const name = idPath ? idPath.split('/').filter(Boolean).at(-1) : /\.aspx$/i.test(last) ? '' : last;
    out.title = tidy(name) || (out.kind === 'folder' ? 'SharePoint folder' : 'SharePoint document');
  } else if (host === 'teams.microsoft.com' || host === 'teams.live.com' || host === 'teams.cloud.microsoft') {
    out.provider = 'teams';
    const obj = decode(u.searchParams.get('objectUrl') || '');
    if (segs[1] === 'file' || obj) {
      out.kind = 'file';
      out.file_type = (u.searchParams.get('fileType') || extOf(obj)).toLowerCase();
      out.title = tidy(obj.split('/').filter(Boolean).at(-1) || '') || 'Teams file';
    } else if (segs[1] === 'channel' || segs[1] === 'team') {
      out.kind = 'folder';
      out.title = tidy(segs[3] || '') || 'Teams channel';
    } else {
      out.title = 'Teams link';
    }
  } else if (host === '1drv.ms' || host === 'onedrive.live.com') {
    out.provider = 'onedrive';
    out.kind = segs[0] === 'f' ? 'folder' : 'file';
    out.file_type = SP_KIND[segs[0]] || '';
    out.title = 'OneDrive ' + (out.kind === 'folder' ? 'folder' : 'file');
    out.note = 'OneDrive short links are sharing links. Check who it was shared with before relying on it for the team.';
  } else if (host === 'github.com') {
    out.provider = 'github';
    if (segs[2] === 'blob') {
      out.kind = 'file';
      out.file_type = extOf(last);
      out.title = last;
    } else if (segs[2] === 'tree') {
      out.kind = 'folder';
      out.title = `${segs[1]}: ${segs.slice(4).join('/') || segs[3] || ''}`.trim();
    } else if (segs[2] === 'issues' || segs[2] === 'pull') {
      out.title = `${segs[1]} ${segs[2] === 'pull' ? 'PR' : 'issue'} #${segs[3] || ''}`;
    } else {
      out.kind = 'repo';
      out.title = segs.slice(0, 2).join('/') || 'GitHub';
    }
  } else if (host === 'docs.google.com' || host === 'drive.google.com') {
    out.provider = 'google';
    out.kind = segs.includes('folders') ? 'folder' : 'file';
    out.file_type = { document: 'docx', spreadsheets: 'xlsx', presentation: 'pptx' }[segs[0]] || '';
    out.title = 'Google ' + (out.kind === 'folder' ? 'Drive folder' : { document: 'Doc', spreadsheets: 'Sheet', presentation: 'Slides' }[segs[0]] || 'Drive file');
  } else if (host.endsWith('onshape.com')) {
    out.provider = 'onshape';
    out.kind = 'file';
    out.title = 'Onshape document';
  } else if (host.endsWith('grabcad.com')) {
    out.provider = 'grabcad';
    out.kind = segs.includes('files') ? 'file' : 'folder';
    out.title = 'GrabCAD ' + (out.kind === 'file' ? 'file' : 'project');
  } else {
    let site = null;
    try {
      site = siteUrl ? new URL(siteUrl) : null;
    } catch { /* no site address configured */ }
    if (site && host === site.hostname.toLowerCase()) {
      out.provider = 'onesolar';
      const app = segs.find((s) => ['gatorwire', 'orders', 'inventory', 'evals', 'finances', 'sponsors', 'scope-map', 'projects'].includes(s));
      out.title = app ? `one.solar: ${app === 'gatorwire' ? 'GatorWire' : app[0].toUpperCase() + app.slice(1)}` : 'one.solar';
    } else {
      out.kind = extOf(last) ? 'file' : 'page';
      out.file_type = extOf(last);
      out.title = tidy(last) || host.replace(/^www\./, '');
    }
  }
  if (out.file_type && !/^[a-z0-9_]{1,12}$/.test(out.file_type)) out.file_type = '';
  out.title = out.title.slice(0, 200) || 'Linked document';
  return out;
}

/** A document category guessed from the kind of file (the person can change it). */
export function guessCategory(r) {
  const t = (r.file_type || '').toLowerCase();
  if (['sldprt', 'sldasm', 'step', 'stp', 'iges', 'igs', 'stl', 'ipt', 'iam', 'f3d'].includes(t) || ['onshape', 'grabcad'].includes(r.provider)) return 'CAD';
  if (['slddrw', 'dxf', 'dwg'].includes(t)) return 'Drawings';
  if (['m', 'mat', 'py', 'ipynb', 'xlsx', 'xlsm'].includes(t)) return 'Analysis';
  return '';
}
