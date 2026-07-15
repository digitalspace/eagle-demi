import { TestBed } from '@angular/core/testing';
import { RegistryStateService } from './registry-state.service';

describe('RegistryStateService', () => {
  let service: RegistryStateService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [RegistryStateService]
    });
    service = TestBed.inject(RegistryStateService);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });

  it('should have correct default signal values', () => {
    expect(service.activeBoundaryLayer()).toBe('regions');
    expect(service.boundaryFilter()).toBe('all');
    expect(service.loadedBoundariesGeoJSON()).toEqual({});
    expect(service.activeBoundaryNames()).toEqual([]);
  });

  it('should compute activeBoundaryNames alphabetically', () => {
    service.activeBoundaryLayer.set('regionalDistricts');
    service.loadedBoundariesGeoJSON.set({
      regionalDistricts: [
        { name: 'Capital' },
        { name: 'Alberni-Clayoquot' },
        { name: 'Bulkley-Nechako' }
      ]
    });

    expect(service.activeBoundaryNames()).toEqual([
      'Alberni-Clayoquot',
      'Bulkley-Nechako',
      'Capital'
    ]);
  });

  it('should load boundary geometry from cache if available', async () => {
    const mockData = [{ name: 'Test District' }];
    service.loadedBoundariesGeoJSON.set({
      regionalDistricts: mockData
    });

    const result = await service.loadBoundaryGeometry('regionalDistricts');
    expect(result).toBe(mockData);
  });

  it('should fetch boundary geometry and update cache if not cached', async () => {
    const mockResponse = [{ name: 'Fetched District' }];
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    service.activeBoundaryLayer.set('regionalDistricts');
    const result = await service.loadBoundaryGeometry('regionalDistricts');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result).toEqual(mockResponse);
    expect(service.loadedBoundariesGeoJSON()['regionalDistricts']).toEqual(mockResponse);
  });

  it('should load single boundary geometry from cache if available', async () => {
    const mockData = [{ name: 'Victoria-Beacon Hill', geometry: { type: 'Polygon', coordinates: [] } }];
    service.loadedBoundariesGeoJSON.set({
      electoralDistricts: mockData
    });

    const result = await service.loadSingleBoundaryGeometry('electoralDistricts', 'Victoria-Beacon Hill');
    expect(result).toBe(mockData[0]);
  });

  it('should fetch single boundary geometry and update cache if not already cached with geometry', async () => {
    const initialCache = [{ name: 'Victoria-Beacon Hill' }];
    service.loadedBoundariesGeoJSON.set({
      electoralDistricts: initialCache
    });

    const mockResponse = { name: 'Victoria-Beacon Hill', geometry: { type: 'Polygon', coordinates: [[1, 2]] } };
    const fetchSpy = spyOn(window, 'fetch').and.resolveTo(new Response(JSON.stringify(mockResponse), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }));

    const result = await service.loadSingleBoundaryGeometry('electoralDistricts', 'Victoria-Beacon Hill');

    expect(fetchSpy).toHaveBeenCalled();
    expect(result).toEqual(mockResponse);
    expect(service.loadedBoundariesGeoJSON()['electoralDistricts'][0].geometry).toEqual(mockResponse.geometry);
  });

  it('should compute filteredProjectsNoQuery based on active filters but ignore search queries', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Mine A', sector: 'Mining', gatingState: 'admitted', region: 'Thompson-Okanagan' },
      { id: 'p2', name: 'Wind B', sector: 'Energy', gatingState: 'admitted', region: 'Thompson-Okanagan' }
    ];
    service.projects.set(mockProjects);
    service.searchQuery.set('Mine'); // search query set to 'Mine'

    // When sector filter is 'all', both are returned by filteredProjectsNoQuery because it ignores search query 'Mine'
    expect(service.filteredProjectsNoQuery()).toEqual(mockProjects);

    // But filteredProjects should honor the search query 'Mine'
    expect(service.filteredProjects()).toEqual([mockProjects[0]]);

    // If sector filter is set to Energy, filteredProjectsNoQuery should filter by sector
    service.sectorFilter.set('Energy');
    expect(service.filteredProjectsNoQuery()).toEqual([mockProjects[1]]);
    // filteredProjects will be empty because Wind B does not match 'Mine'
    expect(service.filteredProjects()).toEqual([]);
  });

  it('should bypass project-matching check for filteredDocuments when on the search page', () => {
    const mockProjects: any[] = [
      { id: 'p1', name: 'Mine A', sector: 'Mining', gatingState: 'admitted', region: 'Thompson-Okanagan' }
    ];
    const mockDocs: any[] = [
      { id: 'd1', displayName: 'Doc A', projectId: 'p1', gatingState: 'admitted' }
    ];
    service.projects.set(mockProjects);
    service.documents.set(mockDocs);

    // Set search page and keyword that does NOT match project name 'Mine A'
    service.activePage.set('search');
    service.searchQuery.set('Doc A');

    // Projects list will be empty because 'Mine A' doesn't match 'Doc A'
    expect(service.filteredProjects()).toEqual([]);

    // But documents list should successfully find the matching document because it bypasses parent project keyword check
    expect(service.filteredDocuments()).toEqual([mockDocs[0]]);

    // When on the map page, it should require the parent project to be in filteredProjectsNoQuery
    service.activePage.set('map');
    service.sectorFilter.set('Energy'); // 'p1' (Mining) is excluded from filteredProjectsNoQuery now
    expect(service.filteredDocuments()).toEqual([]);
  });
});
