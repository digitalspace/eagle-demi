import { Project, Document } from '../models/registry.models';

export const MOCK_PROJECTS: Project[] = [
  {
    id: 111,
    name: "Ajax Mine",
    sector: "Mining",
    status: "Completed",
    legacyEagleId: "588510b0aaecd9001b8142a1",
    centroid: [-120.37, 50.62],
    gatingState: "admitted",
    region: "Thompson-Okanagan",
    description: "KGHM Ajax Mining Inc. proposes to develop a new open-pit copper and gold mine with a production capacity of up to 24 million tonnes of ore per year near Kamloops, British Columbia.",
    proponent: "KGHM Ajax Mining Inc."
  },
  {
    id: 207,
    name: "Nicomen Wind Energy",
    sector: "Energy",
    status: "In Progress",
    legacyEagleId: "58851172aaecd9001b820335",
    centroid: [-121.22, 50.25],
    gatingState: "admitted",
    region: "Thompson-Okanagan",
    description: "Wind energy generation project consisting of up to 40 wind turbines near Lytton, British Columbia.",
    proponent: "Nicomen Wind Energy Corp"
  },
  {
    id: 304,
    name: "Timicw Good Earth Recycling Landfill",
    sector: "Waste Management",
    status: "Completed",
    legacyEagleId: "64a5f1dc2d0a9c002225f25e",
    centroid: [-120.35, 51.10],
    gatingState: "admitted",
    region: "Thompson-Okanagan",
    description: "Recycling and composting facility aiming to process organic and wood wastes into usable agricultural additions.",
    proponent: "Good Earth Recycling Ltd"
  },
  {
    id: 307,
    name: "Tranquille on the Lake",
    sector: "Urban Development",
    status: "In Progress",
    legacyEagleId: "64f9f03e559cf40022effe76",
    centroid: [-120.48, 50.70],
    gatingState: "staged",
    region: "Thompson-Okanagan",
    description: "A comprehensive lakeside resort community master-planned development.",
    proponent: "Tranquille Developments"
  },
  {
    id: 333,
    name: "WCOL Natural Gas Liquids (NGL) Recovery",
    sector: "Energy",
    status: "In Progress",
    legacyEagleId: "620ef49aabfe9500223f403a",
    centroid: [-121.5, 55.7],
    gatingState: "admitted",
    region: "Peace",
    description: "Natural gas extraction, recovery and enrichment processing facility.",
    proponent: "West Coast Olefins Ltd"
  },
  {
    id: 336,
    name: "Westcoast Connector Gas Transmission",
    sector: "Energy",
    status: "Completed",
    legacyEagleId: "588511b7aaecd9001b824889",
    centroid: [-128.5, 54.5],
    gatingState: "admitted",
    region: "Skeena",
    description: "Natural gas pipeline proposal to transport gas from northeast BC to Prince Rupert.",
    proponent: "Spectra Energy"
  },
  {
    id: 401,
    name: "Coastal GasLink Pipeline",
    sector: "Energy",
    status: "Completed",
    legacyEagleId: "588511b8aaecd9001b8249a1",
    centroid: [-124.0, 54.0],
    gatingState: "admitted",
    region: "Skeena",
    description: "A 670-kilometre pipeline delivering natural gas from northeastern BC to the LNG Canada facility in Kitimat.",
    proponent: "TC Energy"
  },
  {
    id: 402,
    name: "Site C Clean Energy Project",
    sector: "Energy",
    status: "In Progress",
    legacyEagleId: "588511b9aaecd9001b824ab2",
    centroid: [-120.9, 56.2],
    gatingState: "admitted",
    region: "Peace",
    description: "Third dam and hydroelectric generating station on the Peace River in northeastern BC.",
    proponent: "BC Hydro"
  },
  {
    id: 403,
    name: "Blackwater Gold Project",
    sector: "Mining",
    status: "In Progress",
    legacyEagleId: "588511baaaecd9001b824bc3",
    centroid: [-124.8, 53.2],
    gatingState: "admitted",
    region: "Cariboo",
    description: "Gold and silver open-pit mine development located in central British Columbia.",
    proponent: "Artemis Gold Inc."
  },
  {
    id: 404,
    name: "KSM Project",
    sector: "Mining",
    status: "In Progress",
    legacyEagleId: "588511bbaaecd9001b824cd4",
    centroid: [-130.0, 56.5],
    gatingState: "staged",
    region: "Northwest",
    description: "One of the largest undeveloped gold and copper projects in the world, located in northwestern BC.",
    proponent: "Seabridge Gold Inc."
  }
];

export const MOCK_DOCUMENTS: Document[] = [
  {
    id: "doc-ajax-1",
    displayName: "Ajax Mine Project Assessment Report",
    documentFileName: "Ajax_Mine_Assessment_Report.pdf",
    documentType: "Assessment Report",
    orcsCode: "34800-20/AJAX",
    projectId: 111,
    projectName: "Ajax Mine",
    gatingState: "admitted",
    textSnippet: "This assessment report evaluates the environmental, social, economic, heritage, and health effects of the proposed KGHM Ajax Mine project near Kamloops, BC."
  },
  {
    id: "doc-ajax-2",
    displayName: "Environmental Certificate Application Summary",
    documentFileName: "Ajax_Certificate_Application_Summary.pdf",
    documentType: "Application",
    orcsCode: "34800-30/AJAX",
    projectId: 111,
    projectName: "Ajax Mine",
    gatingState: "admitted",
    textSnippet: "KGHM Ajax Mining Inc. submits this application summary for an Environmental Assessment Certificate for development of a copper-gold open-pit mine..."
  },
  {
    id: "doc1",
    displayName: "Environmental Assessment Certificate #14-02",
    documentFileName: "EA_Certificate_14-02_Nicomen.pdf",
    documentType: "Certificate",
    orcsCode: "35400-20/NICO",
    projectId: 207,
    projectName: "Nicomen Wind Energy",
    gatingState: "admitted",
    textSnippet: "Nicomen Wind Energy Corp is hereby authorized to construct and operate up to 40 wind turbines subject to the terms in Schedule A..."
  },
  {
    id: "doc2",
    displayName: "Acoustic Impact Assessment & Noise Model Report",
    documentFileName: "Nicomen_Wind_Acoustic_Noise_Model.pdf",
    documentType: "Assessment Report",
    orcsCode: "35400-30/NICO",
    projectId: 207,
    projectName: "Nicomen Wind Energy",
    gatingState: "admitted",
    textSnippet: "Acoustical models demonstrate noise levels at nearest residential receptors will not exceed 40 dBA under any operational wind configurations..."
  },
  {
    id: "doc3",
    displayName: "Draft Master Landfill Reclamation & Closure Plan",
    documentFileName: "GoodEarth_Landfill_Draft_Closure_Plan_V2.pdf",
    documentType: "Management Plan",
    orcsCode: "32600-40/RECY",
    projectId: 304,
    projectName: "Timicw Good Earth Recycling Landfill",
    gatingState: "admitted",
    textSnippet: "Plan details the progressive capping, gas monitoring, and final vegetation restoration of the landfill site starting in year 2028..."
  }
];
