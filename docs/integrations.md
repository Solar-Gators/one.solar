# Linking records between one.solar apps (the link registry)

Migration 068. A Projects item can link to a record in another one.solar app: an Orders request, an Inventory item,
and any app that registers itself. Projects stores only the link; **each app stays in charge of its own data and of
who may see it.**

## What's registered

| Kind | App | Who can link and see it | Shows |
|---|---|---|---|
| `order` (068) | Orders | any accepted member | status, "not here yet" until Received |
| `inventory` (068) | Inventory | an Inventory permission (`inv_can_view`) | stock and reservations (read from Inventory) |
| `event` (069) | Events | people who can see that event (`ev_sees`) | Upcoming / Past / Cancelled and the date |
| `sponsor` (069) | Sponsors | `sponsors.view` or `sponsors.edit` | stage and season (never amounts or contacts) |
| `item` (069) | Projects | people who can see the other item's project | its status; shown on both items. Not a dependency: it never moves dates |

## How it fits together

```
Projects item page ──► os_link_search / os_link_describe / pm_add_ref   (the only calls the website makes)
                              │  checks: signed in, accepted member (is_member), then the type's can_fn
                              ▼
                       os_link_types row ──► <app>_link_search(p_q, p_limit)
                                         └─► <app>_link_describe(p_ids)
                              ▼
                       os_link_row (id, code, title, status, tone, detail, path)
```

- `pm_refs` holds the link: `kind` (a foreign key to `os_link_types.key`), `ref_id`, a `label` kept for history (so a
  link still reads sensibly if the record is deleted or hidden), and a `note`.
- The page shows each link through `os_link_describe`, so the status is always the record's status now, read with
  the person's own access. A record they can't see shows its stored label without a link.
- The other side, "which project items link to this record?", is `linkedProjectItems(kind, id)` in
  [`orders/js/related.js`](../orders/js/related.js). It returns only items in projects the person can see.

## Adding an app

You need one migration and no Projects code. Use the stand-in "widgets" app in
[`tests/linkRegistry.test.mjs`](../tests/linkRegistry.test.mjs) as a working example.

1. **Describe function.** It returns the records with these ids that the caller may see, as they are now:

   ```sql
   create function public.widgets_link_describe(p_ids uuid[])
   returns setof public.os_link_row language sql stable security definer set search_path = public, pg_temp as $$
     select w.id, w.tag, w.name, w.state,
            case w.state when 'ready' then 'green' else 'gray' end,   -- tone: green / blue / amber / red / gray / null
            null::text,                                              -- detail: a short extra line, or null
            'widgets/#/' || w.id                                     -- path, relative to the site
     from widgets w where widgets_can() and w.id = any(p_ids) $$;
   ```

2. **Search function.** It returns records matching what was typed, at most `p_limit`. Escape `\ % _` in `p_q` so
   they match literally, the way `orders_link_search` does, and return the rows through the describe function so both
   functions agree.
3. **Lock both functions down.** The website must not call them directly:
   `revoke execute on function … from public, anon, authenticated;`
4. **Register the kind:**

   ```sql
   insert into public.os_link_types (key, app, label, noun, add_label, search_hint, note_hint,
                                     search_fn, describe_fn, can_fn, deny_message, sort)
   values ('widget', 'widgets', 'Widget', 'widget', 'Link a widget', 'Tag or name', 'e.g. Needed for layup',
           'public.widgets_link_search(text, int)', 'public.widgets_link_describe(uuid[])',
           'public.widgets_can()', 'Your role can''t see widgets, so you can''t link them.', 30);
   ```

   - `label` is the chip on a link, `noun` appears in messages ("That widget doesn't exist."), and `add_label` is
     the button text.
   - `can_fn` is optional: a no-argument function returning boolean. If it returns false, search and linking show
     `deny_message`, and existing links show only their stored label.
   - `sort` sets the button order. `active = false` hides the kind without losing its links.

The item page's "+ Link a widget" button, the search dialog and the live status chip then all work.

## Rules

- **Never expose more than the app's own page would.** The functions are `security definer`, so they must apply the
  app's own visibility rule (as `inv_can_view()` does for Inventory). Return nothing rather than raising for
  records the person can't see.
- **No writes.** Linking never changes the other app's record.
- **Keep `os_link_row` small.** It should hold what a chip and a picker need, not the whole record. Anything richer
  (like Inventory's stock and reservations) is read by the page from the app's own calls.
- **Don't expose eval ratings** or anything else the source app keeps private, even in `title` or `detail`.
- Registry rows are read-only from the website. Change them in a migration.
