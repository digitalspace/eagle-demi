import { levelsFor, RbacGroups } from './access-model.component';

const groups = (on: Partial<RbacGroups> = {}): RbacGroups =>
  ({ public: true, idir: false, eao: false, team: false, credential: false, ce: false, ...on });

const siteC = { team: true };   // a project the simulated team originated
const ajax = { team: false };   // someone else's project

const levels = (g: RbacGroups, project: { team: boolean }) =>
  Array.from(levelsFor(g, project)).sort((a, b) => a - b);

describe('levelsFor', () => {
  it('gives an anonymous caller Level 4 only', () => {
    expect(levels(groups(), siteC)).toEqual([4]);
  });

  it('gives IDIR Levels 3 and 4, never 2', () => {
    expect(levels(groups({ idir: true }), siteC)).toEqual([3, 4]);
  });

  it('gives EAO staff Levels 2 to 4, never Team Only', () => {
    expect(levels(groups({ eao: true }), siteC)).toEqual([2, 3, 4]);
  });

  it('gives the team Levels 1 to 4 on its own project and nothing extra elsewhere', () => {
    expect(levels(groups({ team: true }), siteC)).toEqual([1, 2, 3, 4]);
    expect(levels(groups({ team: true }), ajax)).toEqual([4]);
  });

  it('gives a selected credential Level 2 on the named project only', () => {
    expect(levels(groups({ credential: true }), siteC)).toEqual([2, 4]);
    expect(levels(groups({ credential: true }), ajax)).toEqual([4]);
  });

  it('opens the sealed compartment for C&E without granting Levels 1 to 3', () => {
    expect(levels(groups({ ce: true }), siteC)).toEqual([0, 4]);
  });
});
