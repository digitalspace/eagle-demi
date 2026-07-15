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
});
