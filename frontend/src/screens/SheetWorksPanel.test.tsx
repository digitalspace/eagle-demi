import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { SheetWorksPanel } from './SheetWorksPanel';
import { json, respond, urlOf } from '../test-http';
import { queryWrapper, testQueryClient, withQueryClient } from '../test-query';
import FIXTURE from '../../parity/fixtures/projects-901-sheet-works.json';

const EMPTY = 'No works from the business spreadsheets are stored for this project.';

const renderPanel = () => render(withQueryClient(<SheetWorksPanel projectId="901" />));

afterEach(() => vi.unstubAllGlobals());

describe('SheetWorksPanel', () => {
  it('reads the project’s sheet works and groups them by Act with counts', async () => {
    const fetchMock = respond(json(FIXTURE));

    renderPanel();

    expect(await screen.findByText('1996 Act (1)')).toBeInTheDocument();
    expect(screen.getByText('2002 Act (4)')).toBeInTheDocument();
    expect(urlOf(fetchMock.mock.calls[0])).toMatch(/\/projects\/901\/sheet-works$/);
  });

  it('marks each work with how the public read will treat it', async () => {
    respond(json(FIXTURE));

    renderPanel();

    expect(await screen.findByText('Hidden when the public site shows sheet works')).toBeInTheDocument();
    expect(screen.getByText('Replaces Track work: Sample Alpha EAC extension')).toBeInTheDocument();
    expect(screen.getByText('Shown until Track has it')).toBeInTheDocument();
  });

  it('says a Track work is replaced when that work has no title', async () => {
    const replacing = FIXTURE.works.find((work) => work.replaces.length)!;
    respond(json({ works: [{ ...replacing, replaces: [{ ...replacing.replaces[0], title: null }] }] }));

    renderPanel();

    expect(await screen.findByText('Replaces a Track work')).toBeInTheDocument();
  });

  it('lists phases in order and says when a phase date is only known as a latest day', async () => {
    respond(json(FIXTURE));

    renderPanel();

    const [phases] = await screen.findAllByRole('list', { name: 'Phases' });
    const rows = within(phases).getAllByRole('listitem');
    expect(rows.map((row) => within(row).getByText(/Application/).textContent)).toEqual([
      'Pre-Application',
      'Application Review',
    ]);
    expect(within(rows[0]).getByText(/Start date not known, before 1 Mar 2001/)).toBeInTheDocument();
    expect(within(rows[0]).getByText('Date not known')).toBeInTheDocument();
    expect(within(rows[0]).getByText('—')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Withdrawn · Moved to the 2002 Act')).toBeInTheDocument();
  });

  it('spells out each work’s dates, interruptions, move and milestones', async () => {
    const [withdrawn, assessment, amendment] = FIXTURE.works;
    const [held] = assessment.milestones;
    respond(
      json({
        works: [
          { ...withdrawn, transitionOut: { ...withdrawn.transitionOut, date: '2003-06-01' } },
          {
            ...assessment,
            milestones: [
              held,
              {
                ...held,
                name: 'Report due',
                actualDate: null,
                anticipatedDate: '2014-05-01',
                endDate: null,
                numberOfDays: null,
                undated: { actualDate: { notAfter: '2014-06-01' } },
              },
            ],
          },
          { ...amendment, undated: { ...amendment.undated, decisionDate: { notAfter: '2018-06-01' } } },
        ],
      }),
    );

    renderPanel();

    expect(await screen.findByText('Assessment · Start date not known, before 1 Mar 2001 · Decision 10 Apr 2003')).toBeInTheDocument();
    expect(screen.getByText('Withdrawn · Moved to the 2002 Act on 1 Jun 2003')).toBeInTheDocument();
    expect(screen.getByText('Suspension s.30(1) · from 1 Jun 2002 · to 1 Jul 2002 · 30 days')).toBeInTheDocument();
    expect(screen.getByText('Amendment · Decision date not known, before 1 Jun 2018 · Decision expected 1 Mar 2018')).toBeInTheDocument();
    const milestones = screen.getByRole('list', { name: 'Milestones' });
    expect(within(milestones).getByText('To 5 Mar 2014 · 30 days')).toBeInTheDocument();
    expect(within(milestones).getByText('Actual date not known, before 1 Jun 2014 · Expected 1 May 2014')).toBeInTheDocument();
  });

  it('folds an Act with more than five works and leaves five open', async () => {
    const [first] = FIXTURE.works;
    const works = (count: number, actYear: number) =>
      Array.from({ length: count }, (_, i) => ({ ...first, workId: `${actYear}-${i}`, actYear }));
    respond(json({ works: [...works(5, 1996), ...works(6, 2002)] }));

    renderPanel();

    expect((await screen.findByText('2002 Act (6)')).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('1996 Act (5)').closest('details')).toHaveAttribute('open');
  });

  it.each([404, 500])('renders nothing when the first read answers %i', async (status) => {
    respond(json({ error: 'no' }, status));
    const client = testQueryClient();
    const Wrapper = queryWrapper(client);

    const { container } = render(<Wrapper><SheetWorksPanel projectId="901" /></Wrapper>);

    await waitFor(() => expect(client.getQueryState(['sheet-works', '901'])?.status).toBe('error'));
    expect(container).toBeEmptyDOMElement();
  });

  it.each([500, 403])('keeps works already shown when a later read answers %i', async (status) => {
    // A 403 is sent twice: the client refreshes the token and replays once.
    respond(json(FIXTURE), json({ error: 'no' }, status), json({ error: 'no' }, status));
    const client = testQueryClient();
    const Wrapper = queryWrapper(client);
    render(<Wrapper><SheetWorksPanel projectId="901" /></Wrapper>);
    expect(await screen.findByText('1996 Act (1)')).toBeInTheDocument();

    await client.refetchQueries({ queryKey: ['sheet-works', '901'] });

    expect(client.getQueryState(['sheet-works', '901'])?.status).toBe('error');
    expect(await screen.findByText('1996 Act (1)')).toBeInTheDocument();
    expect(screen.queryByText('Only staff can see the sheet works.')).not.toBeInTheDocument();
  });

  it('tells a caller without staff access that the works are staff only', async () => {
    respond(json({ error: 'Forbidden' }, 403), json({ error: 'Forbidden' }, 403));

    renderPanel();

    expect(await screen.findByText('Only staff can see the sheet works.')).toBeInTheDocument();
  });

  it('reads an empty body as no works', async () => {
    respond(json({}));

    renderPanel();

    expect(await screen.findByText(EMPTY)).toBeInTheDocument();
  });
});
