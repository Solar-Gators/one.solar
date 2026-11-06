/**
 * The apps on the OneSolar home screen. Add, remove or reorder cards here.
 *
 *   id        short name, used for the icon colour
 *   name      card title
 *   blurb     one line on what it's for
 *   href      where it opens: a folder of this site (orders/#/new, evals/), or a full URL
 *   icon      an emoji or a short symbol
 *   access    'public'  anyone, signed in or not
 *             'signedIn' anyone with an Order Form account
 *             ['perm', …] only people whose role has one of these Order Form permissions
 *   links     optional shortcuts under the card: [{ label, href, access }]
 *   note      optional small print (e.g. "Not live yet")
 *
 * Hiding a card is only for tidiness. Each app's own database rules still decide
 * who can see what; anyone can type an app's address.
 */
export const APPS = [
  {
    id: 'orders',
    name: 'Orders',
    blurb: 'Request parts and follow them through approval, ordering and delivery.',
    href: 'orders/#/home',
    icon: '📦',
    access: 'signedIn',
    links: [
      { label: 'New request', href: 'orders/#/new' },
      { label: 'My requests', href: 'orders/#/requests' },
      { label: 'Queue', href: 'orders/#/queue', access: ['request.review', 'request.order'] },
    ],
  },
  {
    id: 'sponsors',
    name: 'Sponsors',
    blurb: 'Sponsorships and donations from first contact to thank-you, for every car.',
    href: 'sponsors/',
    icon: '🤝',
    access: ['sponsors.view', 'sponsors.edit'],
  },
  {
    id: 'finances',
    name: 'Finances',
    blurb: 'Budgets, purchases and funding: the Treasurer\'s ledger.',
    href: 'finances/',
    icon: '💵',
    access: ['finances.view', 'finances.edit'],
  },
  {
    id: 'evals',
    name: 'Solar Evals',
    blurb: 'Semester member reviews: CE rubrics and evaluations, filled out online.',
    href: 'evals/',
    icon: '📝',
    access: 'signedIn',
  },
  {
    id: 'gatorwire',
    name: 'GatorWire',
    blurb: 'Turn a draw.io wiring diagram into a full wiring spec: connectors, conductors and splices.',
    href: 'gatorwire/',
    icon: '🔌',
    access: 'public',
  },
  {
    id: 'scope',
    name: 'CE Scope Map',
    blurb: 'Who owns what: Chief Engineer responsibilities and where their scopes overlap.',
    href: 'scope-map/',
    icon: '🗺️',
    access: 'public',
  },
  {
    id: 'admin',
    name: 'Admin',
    blurb: 'People and positions, permissions, the request form, approval rules, notifications and the season.',
    href: 'admin/',
    icon: '⚙️',
    access: ['users.manage', 'settings.edit', 'site.customize', 'seasons.manage', 'workflow.edit'],
    links: [
      { label: 'Users', href: 'admin/#/admin/users', access: ['users.manage'] },
      { label: 'Roles & permissions', href: 'admin/#/admin/roles', access: ['users.manage'] },
      { label: 'Notifications', href: 'admin/#/admin/notifications', access: ['workflow.edit'] },
    ],
  },
  {
    id: 'website',
    name: 'Solar Gators website',
    blurb: 'Our official site: the team, the cars, our sponsors and how to join.',
    href: 'https://ufsolargators.org/',
    icon: '🌐',
    access: 'public',
  },
];
