import { SCREENS } from './screens';

/**
 * Which screen a URL belongs to. Compared on the first segment, not the whole path: a screen may
 * carry a deeper one (`/projects/272`), and it still owns every URL under it.
 */
export function screenKeyOf(pathname: string): string {
  const segment = pathname.replace(/^\//, '').split('/')[0] || 'map';
  return SCREENS.find((screen) => screen.path.split('/')[1] === segment)?.key ?? segment;
}
