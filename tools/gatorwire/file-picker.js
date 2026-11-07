/*
 * OneSolar: the Share dialog lists every .json file in the repository to pick from, instead of
 * typing the file's exact name. tools/gatorwire-onesolar.mjs puts this into a GatorWire build,
 * replacing each $name with what that build calls it (the build's names are minified).
 */
async function gwListJson(e,t){let n=$parseRepo(e);if(!n)return null;let r={...n,apiBase:$apiBase()},i=await fetch(`${$repoUrl(r)}/git/trees/HEAD?recursive=1`,{headers:$headers(t||$savedToken()||void 0),cache:`no-store`}).catch($offline);if(i.status===409)return[];if(!i.ok)throw await $githubError(i,`list the files`);let a=await i.json();return(a.tree||[]).filter(e=>e.type===`blob`&&/\.json$/i.test(e.path)).map(e=>({path:e.path,size:e.size??0})).sort((e,t)=>(e.path===`project.json`?-1:t.path===`project.json`?1:0)||e.path.localeCompare(t.path))}
var gwKb=e=>e<1024?`${e} B`:e<1048576?`${(e/1024).toFixed(e<10240?1:0)} KB`:`${(e/1048576).toFixed(1)} MB`;
function GwFiles({repo,token,value,onChange}){
  const tok=token&&token.trim().length>=40?token.trim():void 0;
  const [list,setList]=(0,$react.useState)({loading:!1,files:null,error:null,repo:``});
  const [isNew,setIsNew]=(0,$react.useState)(!1);
  const [again,setAgain]=(0,$react.useState)(0);
  const live=(0,$react.useRef)({value,isNew});live.current={value,isNew};
  (0,$react.useEffect)(()=>{
    let alive=!0;
    if(!$parseRepo(repo)){setList({loading:!1,files:null,error:null,repo:``});return}
    setList(x=>({...x,loading:!0,error:null}));
    const timer=setTimeout(()=>{gwListJson(repo,tok).then(files=>{
      if(!alive)return;
      setList({loading:!1,files,error:null,repo:repo.trim()});
      const cur=live.current;
      if(!files.length)setIsNew(!0);
      else if(files.some(f=>f.path===cur.value))setIsNew(!1);
      else if(!cur.isNew)onChange(files[0].path); /* project.json first, else the first file */
    }).catch(err=>{if(alive){setList({loading:!1,files:null,error:String(err.message),repo:``});setIsNew(!0)}})},350);
    return()=>{alive=!1;clearTimeout(timer)}
  },[repo,tok,again]);
  const files=list.files;
  return (0,$jsx.jsxs)(`div`,{className:`gw-files`,children:[
    (0,$jsx.jsxs)(`div`,{className:`gw-files-head`,children:[(0,$jsx.jsx)(`span`,{children:`Project file`}),(0,$jsx.jsx)(`button`,{type:`button`,className:`gw-refresh`,disabled:list.loading||!$parseRepo(repo),onClick:()=>setAgain(n=>n+1),title:`Look again for files in the repository`,children:list.loading?`Looking…`:`↻ Refresh`})]}),
    list.loading&&!files?(0,$jsx.jsxs)(`p`,{children:[`Looking for project files in `,repo.trim(),`…`]}):null,
    list.error?(0,$jsx.jsxs)(`div`,{className:`share-error`,children:[list.error,` Type the file name below instead.`]}):null,
    files&&files.length?(0,$jsx.jsx)(`div`,{className:`gw-file-list`,role:`radiogroup`,"aria-label":`Project file`,children:files.map(f=>(0,$jsx.jsxs)(`label`,{className:`gw-file${!isNew&&f.path===value?` on`:``}`,children:[(0,$jsx.jsx)(`input`,{type:`radio`,name:`gw-file`,checked:!isNew&&f.path===value,onChange:()=>{setIsNew(!1);onChange(f.path)}}),(0,$jsx.jsx)(`span`,{className:`gw-file-name`,children:f.path}),(0,$jsx.jsx)(`small`,{children:gwKb(f.size)})]},f.path))}):null,
    files&&!files.length?(0,$jsx.jsxs)(`p`,{children:[`There are no .json files in `,list.repo,` yet. Name one below; it's created the first time you save.`]}):null,
    files&&files.length?(0,$jsx.jsxs)(`label`,{className:`gw-file gw-file-new${isNew?` on`:``}`,children:[(0,$jsx.jsx)(`input`,{type:`radio`,name:`gw-file`,checked:isNew,onChange:()=>{setIsNew(!0);onChange(``)}}),(0,$jsx.jsx)(`span`,{className:`gw-file-name`,children:`A new file…`}),(0,$jsx.jsx)(`small`,{children:`start a separate project`})]}):null,
    isNew||!files?(0,$jsx.jsx)(`input`,{type:`text`,value,onChange:e=>onChange(e.target.value),placeholder:`e.g. car6-lv-harness.json`,spellCheck:!1,"aria-label":`File in the repository`}):null
  ]})}
