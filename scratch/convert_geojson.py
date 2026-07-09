import json
import math
import os

def transform_pt(x, y):
    # BC Albers EPSG:3005 projection parameters
    phi1 = 50.0 * math.pi / 180.0
    phi2 = 58.5 * math.pi / 180.0
    phi0 = 45.0 * math.pi / 180.0
    lambda0 = -126.0 * math.pi / 180.0
    R = 6378137.0

    n = (math.sin(phi1) + math.sin(phi2)) / 2.0
    C = math.cos(phi1)**2 + 2.0 * n * math.sin(phi1)
    rho0 = (R / n) * math.sqrt(C - 2.0 * n * math.sin(phi0))

    x_prime = x - 1000000.0
    y_prime = y

    rho = math.sqrt(x_prime**2 + (rho0 - y_prime)**2)
    if rho == 0.0:
        return [-126.0, 45.0]

    theta = math.atan2(x_prime, rho0 - y_prime)

    # Calculate lat/lng
    # Bound the arcsin argument just in case of rounding errors
    arg = (C - (rho * n / R)**2) / (2.0 * n)
    arg = max(-1.0, min(1.0, arg))
    
    phi = math.asin(arg)
    lng = lambda0 + theta / n

    return [lng * 180.0 / math.pi, phi * 180.0 / math.pi]

def transform_coords(coords, decimate=True):
    if not isinstance(coords, list):
        return coords
    
    # If it is a coordinate pair [x, y]
    if len(coords) == 2 and isinstance(coords[0], (int, float)):
        return transform_pt(coords[0], coords[1])
        
    # If it is a list of coordinate pairs or lists (e.g. rings)
    # If this is a ring (list of points), we can optionally decimate to save 90% of file size
    if len(coords) > 0 and isinstance(coords[0], list) and len(coords[0]) == 2 and isinstance(coords[0][0], (int, float)):
        pts = [transform_pt(pt[0], pt[1]) for pt in coords]
        if decimate and len(pts) > 10:
            # Keep 1 every 15 points to make map rendering extremely fast and file size ultra-lightweight
            simplified = pts[::15]
            # Ensure polygon is closed by appending the first point at the end
            if simplified[-1] != simplified[0]:
                simplified.append(simplified[0])
            return simplified
        return pts

    return [transform_coords(sub, decimate) for sub in coords]

def main():
    infile = "/root/repos/eagle-demi/env_regional_boundaries.geojson"
    outfile = "/root/repos/eagle-demi/frontend/public/env_regional_boundaries_reprojected.geojson"
    
    print(f"Reading GeoJSON from: {infile}")
    with open(infile, "r", encoding="utf-8") as f:
        data = json.load(f)
        
    new_features = []
    for feat in data.get("features", []):
        props = feat.get("properties", {})
        geom = feat.get("geometry", {})
        
        region_num = props.get("REGION_NUMBER")
        region_name = props.get("REGION_NAME")
        
        print(f"Reprojecting region: {region_num} - {region_name}")
        
        # Transform the coordinates recursively with decimation
        new_coords = transform_coords(geom.get("coordinates", []), decimate=True)
        
        new_feat = {
            "type": "Feature",
            "properties": {
                "regionNumber": region_num,
                "regionName": region_name
            },
            "geometry": {
                "type": geom.get("type"),
                "coordinates": new_coords
            }
        }
        new_features.append(new_feat)
        
    new_geojson = {
        "type": "FeatureCollection",
        "features": new_features
    }
    
    print(f"Writing reprojected GeoJSON to: {outfile}")
    os.makedirs(os.path.dirname(outfile), exist_ok=True)
    with open(outfile, "w", encoding="utf-8") as f:
        json.dump(new_geojson, f, indent=2)
        
    print("Reprojection and simplification completed successfully!")

if __name__ == "__main__":
    main()
