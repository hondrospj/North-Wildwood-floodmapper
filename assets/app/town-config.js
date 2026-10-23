
const BUNNY_STORAGE_ZONE_ID = "5907481";
const BUNNY_CDN_BASE_URL = "https://floodmapperv1.b-cdn.net";

function bunnyCdnUrl(path) {
  const cleanBase = String(BUNNY_CDN_BASE_URL || "").replace(/\/+$/, "");
  const cleanPath = String(path || "")
    .replace(/^\/+/, "")
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");
  return `${cleanBase}/${cleanPath}`;
}

TOWN_CONFIG = {
  "pageTitle": "North Wildwood Flood Mapper",
  "mapTitle": "North Wildwood Flood Mapper",
  "brandTitleLine1": "North Wildwood",
  "brandTitleLine2": "Flood Mapper",
  "data": {
    "forecastPath": "./forecast.json",
    "observedPath": "./observed.json",
    "observed15MinPath": "./stone_harbor_observed15min.json",
    "observedArchiveIndexPath": "./observed_archive_index.json?policy=20260921-usgs-first",
    "lewesArchiveIndexPath": "./lewes_archive_index.json",
    "lewesHourlyPath": "./lewes_hourly.json",
    "topTidesPath": "./toptides.json",
    "returnIntervalsPath": "./return_intervals.json",
    "surrogateArchiveIndexPath": "./lewes_archive_index.json",
    "surrogateHourlyPath": "./lewes_hourly.json",
    "canonicalDailyPath": "./canonical_daily_v2.json",
    "returnLevelsPath": "./return_interval_levels_v2.json"
  },
  "bunny": {
    "storageZoneId": "5907481",
    "cdnBaseUrl": "https://floodmapperv1.b-cdn.net"
  },
  "assets": {
    "titleLogoPath": null,
    "titleLogoAlt": "",
    "partnerLogoPath": null,
    "partnerLogoFallbackPath": null,
    "partnerLogoAlt": "",
    "rightRailLogoPath": null,
    "rightRailLogoAlt": ""
  },
  "links": {
    "partnerUrl": "https://cupajoe.live",
    "partnerAriaLabel": "Visit cupajoe.live"
  },
  "site": {
    "name": "North Wildwood",
    "municipalityName": "North Wildwood",
    "county": "CAPE MAY",
    "usgsGaugeId": "01411360",
    "noaaGaugeId": "8557380",
    "petssGaugeId": "8535581",
    "gaugeName": "Stone Harbor"
  },
  "datums": {
    "helpText": "Changing the reference changes the number shown, not the mapped flood area.",
    "navd88OffsetFromMllwFt": -2.75,
    "offsets": {
      "navd88": 0,
      "mllw": 2.75
    }
  },
  "thresholds": {
    "navd88": {
      "minor": 3.25,
      "moderate": 4.25,
      "major": 5.25
    },
    "mllw": {
      "minor": 6,
      "moderate": 7,
      "major": 8
    }
  },
  "overlays": {
    "depthPngPrefix": "NorthWildwoodDepth",
    "stagePngPrefix": "NorthWildwoodStage",
    "boundsWgs84": {
      "south": 38.9875038,
      "west": -74.8191427,
      "north": 39.026374,
      "east": -74.7805143
    },
    "worldFileRasterSize": {
      "width": 2186,
      "height": 2824
    },
    "worldFileCornersWgs84": {
      "northWest": [
        39.026275100631,
        -74.819142704419
      ],
      "northEast": [
        39.026374017662,
        -74.780667213004
      ],
      "southEast": [
        38.987603225736,
        -74.780514043454
      ],
      "southWest": [
        38.987504444587,
        -74.818968538313
      ]
    },
    "cacheVersions": {
      "depth": "20260822-mask-stabilizer-v40",
      "dynamic": "20260822-mask-stabilizer-v40",
      "hydraulic": "20260822-mask-stabilizer-v40"
    },
    "modelKind": "phase-aware developed-land conditional connectivity",
    "phaseInvariant": false,
    "depthQueryPngPath": "./assets/hydraulic-v29/COGs/North%20Wildwood/NorthWildwoodHydraulicQuery5ft.png?v=20260822-mask-stabilizer-v40",
    "developedQueryPngPath": "./assets/hydraulic-v29/COGs/North%20Wildwood/NorthWildwoodDevelopedMask5ft.png?v=20260822-mask-stabilizer-v40",
    "depthQueryCogPath": null,
    "physicsForecastPointerPath": null,
    "physicsForecastCyclePointerTemplatePath": null,
    "hydraulicStatesPath": "./assets/hydraulic-v29/COGs/North%20Wildwood/NorthWildwoodHydraulicStates.json.png?v=20260822-mask-stabilizer-v40",
    "depthRoots": [
      "./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/",
      "https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/"
    ],
    "dynamicRoots": [
      "./assets/hydraulic-v29/StagePNGs/North%20Wildwood/",
      "https://floodmapperv1.b-cdn.net/StagePNGs/North%20Wildwood/v37/"
    ],
    "phaseRoots": {
      "depth": {
        "filling": [
          "./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/filling/",
          "https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/filling/"
        ],
        "slack": [
          "./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/",
          "https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/"
        ],
        "draining-release-15": [
          "./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/draining-release-15/",
          "https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/draining-release-15/"
        ],
        "draining-release-30": [
          "./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/draining-release-30/",
          "https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/draining-release-30/"
        ],
        "draining": [
          "./assets/hydraulic-v29/DepthPNGs/North%20Wildwood/draining/",
          "https://floodmapperv1.b-cdn.net/DepthPNGs/North%20Wildwood/v37/draining/"
        ]
      },
      "dynamic": {
        "filling": [
          "./assets/hydraulic-v29/StagePNGs/North%20Wildwood/filling/",
          "https://floodmapperv1.b-cdn.net/StagePNGs/North%20Wildwood/v37/filling/"
        ],
        "slack": [
          "./assets/hydraulic-v29/StagePNGs/North%20Wildwood/",
          "https://floodmapperv1.b-cdn.net/StagePNGs/North%20Wildwood/v37/"
        ],
        "draining-release-15": [
          "./assets/hydraulic-v29/StagePNGs/North%20Wildwood/draining-release-15/",
          "https://floodmapperv1.b-cdn.net/StagePNGs/North%20Wildwood/v37/draining-release-15/"
        ],
        "draining-release-30": [
          "./assets/hydraulic-v29/StagePNGs/North%20Wildwood/draining-release-30/",
          "https://floodmapperv1.b-cdn.net/StagePNGs/North%20Wildwood/v37/draining-release-30/"
        ],
        "draining": [
          "./assets/hydraulic-v29/StagePNGs/North%20Wildwood/draining/",
          "https://floodmapperv1.b-cdn.net/StagePNGs/North%20Wildwood/v37/draining/"
        ]
      }
    },
    "stageCodeScale": 100,
    "stageCodeWidth": 4
  },
  "parcels": {
    "boundaryPngPath": "./assets/parcel-history-v2/NorthWildwoodParcelBoundaries.png?v=20260802-red-parcels-v1",
    "geojsonPath": "./assets/parcel-history-v2/NorthWildwoodParcels.geojson?v=20260816-nsi-2026-floor-v1",
    "houseAlertCdfPath": "./assets/parcel-history-v2/NorthWildwoodHouseAlertCDF.json?v=20260816-nsi-2026-floor-v1"
  },
  "structures": {
    "nsi2026GeojsonPath": "./assets/nsi-2026/NorthWildwoodNSI2026Structures.geojson?v=20260816-nsi-floor-impact-v2",
    "buildings3dPath": "./assets/3d/NorthWildwoodBuildings3D.geojson?v=20260825-nw-3d-v61"
  },
  "addressLookup": {
    "title": "Find a North Wildwood Address",
    "displayName": "North Wildwood",
    "city": "North Wildwood",
    "state": "NJ",
    "stateName": "New Jersey",
    "countryCode": "us",
    "sourceCountry": "USA",
    "postalCode": "",
    "placeholder": "Example: 123 Main St",
    "buttonText": "Search North Wildwood",
    "bbox": {
      "west": -74.8190324,
      "south": 38.9875662,
      "east": -74.7806391,
      "north": 39.0263239
    },
    "geocodeCenter": {
      "lat": 39.006945,
      "lon": -74.7998357
    },
    "searchDistanceMeters": 9000
  },
  "alerts": {
    "enabled": false,
    "zoneCodes": []
  },
  "exportSlug": "North-Wildwood-floodmapper",
  "boundary": {
    "boundaryUrl": "Boundaries/North Wildwood.geojson",
    "bunnyBoundaryPath": "Boundaries/North Wildwood.geojson",
    "queryUrl": "https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/NJ_Municipalities_3857/FeatureServer/0/query",
    "outFields": "NAME,COUNTY,MUN,MUN_LABEL,MUN_TYPE,GNIS_NAME",
    "queryCandidates": [
      "MUN_LABEL = 'North Wildwood City'",
      "NAME = 'North Wildwood'"
    ]
  },
  "map": {
    "center": {
      "lat": 39.006945,
      "lon": -74.7998357
    }
  },
  "nwsPoint": {
    "lat": 39.006945,
    "lon": -74.7998357
  },
  "observed": {
    "usgsGaugeId": "01411360",
    "usgsParameterCd": "72279",
    "primaryArchiveStartDate": "2007-10-01",
    "sourcePrecedence": [
      "primary-usgs-continuous",
      "bias-corrected-noaa-historical-fill",
      "official-usgs-storm-tide-crest-override"
    ],
    "surrogate": {
      "enabled": true,
      "key": "lewes",
      "stationId": "8557380",
      "stationName": "Lewes, Delaware",
      "stationShort": "Lewes",
      "hostRepo": "Stone-Harbor-Borough-floodmapper",
      "indexPath": "lewes_archive_index.json",
      "hourlyPath": "lewes_hourly.json",
      "shardPath": "observed_archive/lewes/{year}.json",
      "indexUrl": "./lewes_archive_index.json",
      "hourlyUrl": "./lewes_hourly.json",
      "shardPathTemplate": "./observed_archive/lewes/{year}.json",
      "biasCorrectionFt": 0.066,
      "calibrationPairKey": "01411360:lewes"
    },
    "crestStationId": "01411360"
  },
  "release": {
    "reference": "North Wildwood Floodmapper V2",
    "version": "20260920-nj-universal-v2",
    "policy": "Primary USGS continuous record; bias-corrected regional NOAA record fills missing history; the nearest official USGS storm-tide crest overwrites the same date as absolute truth."
  }
};

applyTownConfig(TOWN_CONFIG);

async function preloadNorthWildwoodExperience(mainPromise) {
  // The initial 2D flood map is sufficient to make the app usable. The 3D
  // launcher owns runtime, terrain, and building loading when selected.
  await Promise.allSettled([mainPromise]);
  document.body.dataset.sitePreload = "complete";
  document.body.dataset.sitePreloadBlockingPolicy = "initial-flood-renderer-3d-on-demand";
  document.body.dataset.sitePreloadAvoidedBytes = "3d-observed-parcels-nsi-export-libraries";
  document.body.dataset.map3dDeferredWarmup = "on-demand-no-background-camera-traversal";
  document.body.classList.add("nw-app-ready");
}

const northWildwoodMainPromise = main().catch(err => {
  console.error(err);
  toast(err.message);
  return null;
});
preloadNorthWildwoodExperience(northWildwoodMainPromise);
