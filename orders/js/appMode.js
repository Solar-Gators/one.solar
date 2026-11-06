/**
 * Orders, Finances, Sponsors and Admin are separate OneSolar apps (each with its own address, top bar
 * and menu) built from this same code. Each app's page says which one it is: <body data-app="finances">.
 *
 *   orders/    Home, New request, Requests, Queue, Archive, Export
 *   finances/  #/finances
 *   sponsors/  #/sponsors, #/sponsors/<card>
 *   admin/     #/admin/…
 *
 * My account, Help and Choose a new password work in every app. A link to another app's page
 * (an old email link to orders/#/sponsors/…, or Finances linking to a request) goes to that app.
 */
import { appUrl } from '../../shared/onesolar.js';

export const APPS = {
  orders: { name: 'Orders', home: '/home' },
  finances: { name: 'Finances', home: '/finances' },
  sponsors: { name: 'Sponsors', home: '/sponsors' },
  admin: { name: 'Admin', home: '/admin' },
};

export const APP = APPS[document.body.dataset.app] ? document.body.dataset.app : 'orders';

/** Where this app opens: Orders' Home, the Finances page, the Sponsors board, the first Admin page. */
export const homePath = () => APPS[APP].home;

/** Which app a page belongs to, or null for the pages every app has. */
export function appOf(path) {
  if (/^\/finances(\/|$)/.test(path)) return 'finances';
  if (/^\/sponsors(\/|$)/.test(path)) return 'sponsors';
  if (/^\/admin(\/|$)/.test(path)) return 'admin';
  if (/^\/(account|help|reset-password)$/.test(path)) return null;
  return 'orders';
}

/** The full address of a page in whichever app it belongs to. */
export const pageUrl = (path) => `${appUrl(`${appOf(path) || APP}/`)}#${path}`;
