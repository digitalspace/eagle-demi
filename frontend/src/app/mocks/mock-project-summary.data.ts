import {
  OrganizationRow,
  ProjectFacts,
  ProjectSummaryRecord
} from '../models/project-summary.models';

/**
 * Site C, project 272 — the one project the generator has been run against.
 *
 * Demo fixture only. `USE_MOCK_DATA` swaps the two API reads for these objects so the screen can
 * be shown, styled and reviewed with no API, no token and no model call. Numbers are the real
 * counts found on DEMI test (2,158 documents, 127 inspection records, 8 amendments); the prose is
 * written by hand in the shape the generator emits, NOT copied from a generated row.
 *
 * It deliberately exercises the awkward states as well as the happy one: one nation name that
 * matched no Organization row, and `federal: null`.
 *
 * Document ids are the real EPIC ids for the files they name, so a citation chip in demo mode
 * opens the actual PDF from projects.eao.gov.bc.ca. The ids still written `mock-…` have no public
 * counterpart, and their chips lead to an EPIC 404.
 */
export const MOCK_PROJECT_SUMMARY_FACTS: ProjectFacts = {
  id: '272',
  name: 'Site C Clean Energy Project',
  eagleId: '588511a0aaecd9001b82316d',
  legacyEagleId: '588511a0aaecd9001b82316d',
  proponentName: 'British Columbia Hydro and Power Authority',
  region: 'Peace',
  address: 'Peace River, near Fort St. John, British Columbia',
  legislation: 'Environmental Assessment Act (2002)',
  legislationYear: 2002,
  CEAAInvolvement: 'Joint Review Panel',
  eacDecision: 'Certificate Issued',
  currentPhaseName: 'Post Decision - Construction',
  decisionDate: '2014-10-14',
  eaCertificate: 'E14-01',
  phaseHistory: ['Pre-Application', 'Application Review', 'Post Decision - Construction']
};

export const MOCK_PROJECT_SUMMARY: ProjectSummaryRecord = {
  id: '272',
  projectId: '272',
  eagleId: '588511a0aaecd9001b82316d',
  generatedAt: '2026-09-09T02:00:00.000Z',
  sourceAccess: 'public',
  model: 'gpt-4.1-mini',
  promptVersion: 1,
  usage: { promptTokens: 74812, completionTokens: 3140 },
  estimatedCostCad: 0.0731,
  facts: {
    documentTotal: 2158,
    amendments: [
      { documentId: '5fbd55734ef8af002140db8c', displayName: 'Amendment #8 — Amended Certificate E14-01', datePosted: '2023-06-21' },
      { documentId: 'mock-amend-7', displayName: 'Amendment #7 — Amended Certificate E14-01', datePosted: '2021-11-02' },
      { documentId: 'mock-amend-6', displayName: 'Amendment #6 — Amended Certificate E14-01', datePosted: '2019-08-15' }
    ],
    inspections: {
      count: 127,
      latest: { documentId: '66510f71fb680900224ac077', displayName: 'Inspection Record — Site C, June 2026', datePosted: '2026-06-18' }
    },
    selfReports: {
      count: 8,
      latest: { documentId: '5e962222491d620025cfafae', displayName: 'Annual Compliance Self-Report 2025', datePosted: '2026-03-31' }
    },
    keyDocuments: [
      { role: 'certificate', documentId: '58868f49e036fb010576803d', displayName: 'Environmental Assessment Certificate #E14-01', datePosted: '2014-10-14' },
      { role: 'scheduleA', documentId: 'mock-doc-sched-a', displayName: 'Schedule A — Certified Project Description', datePosted: '2014-10-14' },
      { role: 'scheduleB', documentId: '58868f49e036fb010576803b', displayName: 'Schedule B — Table of Conditions', datePosted: '2014-10-14' },
      { role: 'amendedCertificate', documentId: '5fbd55734ef8af002140db8c', displayName: 'Amended Certificate E14-01 (#8)', datePosted: '2023-06-21' },
      { role: 'application', documentId: 'mock-doc-app', displayName: 'Environmental Impact Statement — Application Materials', datePosted: '2013-01-25' },
      { role: 'assessmentReport', documentId: '5df3e2e4f7f30e0021e93731', displayName: 'Site C Clean Energy Project Assessment Report', datePosted: '2014-10-14' }
    ]
  },
  sections: {
    status: {
      sentence: 'The certificate has been amended eight times since it was issued; the most recent amendment, in June 2023, extended the deadline for reservoir clearing and updated the construction schedule attached to Schedule A.',
      citations: [1]
    },
    conditions: {
      sourceDocumentId: '58868f49e036fb010576803b',
      items: [
        {
          n: 1,
          category: 'Environmental management',
          title: 'Construction Environmental Management Plan',
          oneLiner: 'A single plan covering erosion, spills, air quality and waste must be filed before construction starts.',
          bullets: [
            'The plan must be developed by a qualified professional and filed with the EAO at least 60 days before any site activity.',
            'It has to cover erosion and sediment control, spill prevention and response, air quality, noise and waste management.',
            'Any material change to the plan is filed with the EAO within 30 days of the change taking effect.'
          ],
          citations: [2]
        },
        {
          n: 2,
          category: 'Fish and aquatic habitat',
          title: 'Fisheries and Aquatic Habitat Monitoring and Follow-up',
          oneLiner: 'Fish populations and habitat in the Peace River must be monitored before, during and after construction.',
          bullets: [
            'Monitoring covers fish population abundance, mercury in fish tissue and the productive capacity of replacement habitat.',
            'Results are reported annually to the EAO and to the federal fisheries authority.',
            'Where monitoring shows an effect beyond what was predicted, the holder proposes mitigation within 90 days.'
          ],
          citations: [3]
        },
        {
          n: 3,
          category: 'Wildlife',
          title: 'Wildlife Mitigation and Monitoring Plan',
          oneLiner: 'Clearing must avoid the nesting window, and a monitoring plan tracks moose, bats, and migratory birds.',
          bullets: [
            'Vegetation clearing is prohibited during the regional migratory bird nesting window unless a qualified professional confirms no active nests.',
            'The plan sets out survey methods and reporting for ungulates, bats and species at risk.',
            'Habitat compensation land is secured and reported on before the reservoir is filled.'
          ],
          citations: [4]
        },
        {
          n: 4,
          category: 'Heritage and archaeology',
          title: 'Heritage Resources Management',
          oneLiner: 'Sites found during construction stop work in that area until an archaeologist has assessed them.',
          bullets: [
            'A chance-find procedure applies across the whole footprint for the life of construction.',
            'Indigenous groups are notified within 48 hours of a find and are invited to attend the assessment.',
            'Recovered materials are curated under a provincial heritage permit.'
          ],
          citations: [5]
        },
        {
          n: 5,
          category: 'Indigenous consultation',
          title: 'Ongoing Consultation and Reporting',
          oneLiner: 'Consultation with the nations listed in the certificate continues through construction and operations.',
          bullets: [
            'A consultation record is kept and filed with the EAO annually.',
            'Each nation is offered a meeting before any amendment application is filed.',
            'Traditional land use studies are updated where the footprint changes.'
          ],
          citations: [6]
        },
        {
          n: 6,
          category: 'Reporting and compliance',
          title: 'Annual Compliance Self-Reporting',
          oneLiner: 'The holder files a report each year setting out how every condition was met.',
          bullets: [
            'The report is due within 90 days of the end of each calendar year of construction.',
            'It states, condition by condition, what was done and what remains outstanding.',
            'The EAO may require supporting records for any statement in the report.'
          ],
          citations: [7]
        }
      ]
    },
    amendments: [
      {
        documentId: '5fbd55734ef8af002140db8c',
        sentence: 'Amendment #8 extended the reservoir clearing deadline and replaced the construction schedule in Schedule A.',
        citations: [1]
      },
      {
        documentId: 'mock-amend-7',
        sentence: 'Amendment #7 revised the fisheries monitoring condition to add a mercury sampling programme in the reservoir.',
        citations: [3]
      },
      {
        documentId: 'mock-amend-6',
        sentence: 'Amendment #6 adjusted the certified project description to reflect the relocated Highway 29 alignment.',
        citations: [2]
      }
    ],
    timelineEvents: [
      { date: '2011-01-19', label: 'Joint federal-provincial review panel agreement signed', citations: [8] },
      { date: '2014-05-01', label: 'Joint Review Panel report delivered to both ministers', citations: [8] },
      { date: '2017-08-02', label: 'BC Utilities Commission review of the project ordered', citations: [9] },
      { date: '2021-02-26', label: 'Provincial government confirmed the project would continue after a geotechnical review', citations: [9] }
    ],
    compliance: {
      sourceDocumentId: '66510f71fb680900224ac077',
      paragraph: 'The most recent inspection, in June 2026, found the holder in compliance with the erosion and sediment control conditions at the dam site and the Highway 29 realignment. Two advisories were issued: one on record-keeping for a temporary sediment pond, and one asking for the updated clearing schedule to be filed. No orders were issued and no penalties were imposed.',
      citations: [10]
    },
    nations: [
      { name: 'Doig River First Nation', organizationId: 'mock-org-doig', citations: [11] },
      { name: 'Halfway River First Nation', organizationId: 'mock-org-halfway', citations: [11] },
      { name: 'West Moberly First Nations', organizationId: 'mock-org-westmoberly', citations: [11] },
      { name: 'Prophet River First Nation', organizationId: 'mock-org-prophet', citations: [11] },
      // No Organization row matched this spelling — renders as a plain cited row, not a card.
      { name: 'Saulteau First Nations (Moberly Lake)', organizationId: null, citations: [12] }
    ],
    // No federal Decision Statement or Joint Review Panel condition document is in the registry.
    federal: null
  },
  citations: [
    { n: 1, chunkId: '5fbd55734ef8af002140db8c::p2::c1', documentId: '5fbd55734ef8af002140db8c', pageNumber: 2, documentName: 'Amendment #8 — Amended Certificate E14-01' },
    { n: 2, chunkId: '58868f49e036fb010576803b::p4::c0', documentId: '58868f49e036fb010576803b', pageNumber: 4, documentName: 'Schedule B — Table of Conditions' },
    { n: 3, chunkId: '58868f49e036fb010576803b::p9::c2', documentId: '58868f49e036fb010576803b', pageNumber: 9, documentName: 'Schedule B — Table of Conditions' },
    { n: 4, chunkId: '58868f49e036fb010576803b::p12::c0', documentId: '58868f49e036fb010576803b', pageNumber: 12, documentName: 'Schedule B — Table of Conditions' },
    { n: 5, chunkId: '58868f49e036fb010576803b::p17::c1', documentId: '58868f49e036fb010576803b', pageNumber: 17, documentName: 'Schedule B — Table of Conditions' },
    { n: 6, chunkId: '58868f49e036fb010576803b::p21::c0', documentId: '58868f49e036fb010576803b', pageNumber: 21, documentName: 'Schedule B — Table of Conditions' },
    { n: 7, chunkId: '58868f49e036fb010576803b::p26::c3', documentId: '58868f49e036fb010576803b', pageNumber: 26, documentName: 'Schedule B — Table of Conditions' },
    { n: 8, chunkId: '5df3e2e4f7f30e0021e93731::p31::c0', documentId: '5df3e2e4f7f30e0021e93731', pageNumber: 31, documentName: 'Site C Clean Energy Project Assessment Report' },
    { n: 9, chunkId: '5df3e2e4f7f30e0021e93731::p44::c2', documentId: '5df3e2e4f7f30e0021e93731', pageNumber: 44, documentName: 'Site C Clean Energy Project Assessment Report' },
    { n: 10, chunkId: '66510f71fb680900224ac077::p1::c0', documentId: '66510f71fb680900224ac077', pageNumber: 1, documentName: 'Inspection Record — Site C, June 2026' },
    { n: 11, chunkId: '58868f49e036fb010576803d::p3::c1', documentId: '58868f49e036fb010576803d', pageNumber: 3, documentName: 'Environmental Assessment Certificate #E14-01' },
    { n: 12, chunkId: '5df3e2e4f7f30e0021e93731::p58::c0', documentId: '5df3e2e4f7f30e0021e93731', pageNumber: 58, documentName: 'Site C Clean Energy Project Assessment Report' }
  ]
};

/** The `lists` rows the nation cards join against. Four of the five names above match one. */
export const MOCK_ORGANIZATIONS: OrganizationRow[] = [
  {
    id: 'mock-org-doig',
    name: 'Doig River First Nation',
    companyType: 'Indigenous Group',
    address1: 'Mile 72, Highway 97',
    city: 'Rose Prairie',
    province: 'BC',
    postal: 'V0C 2H0',
    country: 'Canada',
    website: 'https://doigriverfn.com'
  },
  {
    id: 'mock-org-halfway',
    name: 'Halfway River First Nation',
    companyType: 'Indigenous Group',
    address1: 'Box 59',
    city: 'Wonowon',
    province: 'BC',
    postal: 'V0C 2N0',
    country: 'Canada',
    website: 'https://halfwayriverfn.com'
  },
  {
    id: 'mock-org-westmoberly',
    name: 'West Moberly First Nations',
    companyType: 'Indigenous Group',
    address1: 'Box 90',
    city: 'Moberly Lake',
    province: 'BC',
    postal: 'V0C 1X0',
    country: 'Canada',
    website: 'https://westmo.org'
  },
  {
    id: 'mock-org-prophet',
    name: 'Prophet River First Nation',
    companyType: 'Indigenous Group',
    address1: 'Mile 233, Alaska Highway',
    city: 'Fort Nelson',
    province: 'BC',
    postal: 'V0C 1R0',
    country: 'Canada'
  }
];
