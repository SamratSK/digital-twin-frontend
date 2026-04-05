export const BMSCE_CAMPUS_ID = "campus-bmsce";

export const BMSCE_CAMPUS_BOUNDS = [
  [77.56355, 12.94025],
  [77.56755, 12.94335],
];

const CAMPUS_FEATURES = [
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.56378, 12.94038],
          [77.56698, 12.94038],
          [77.56734, 12.94288],
          [77.56658, 12.9432],
          [77.56408, 12.94308],
          [77.56378, 12.94038],
        ],
      ],
    },
    properties: {
      id: BMSCE_CAMPUS_ID,
      label: "BMSCE Campus",
    },
  },
];

const CAMPUS_BUILDING_FEATURES = [
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.565751, 12.940472],
          [77.565814, 12.94083],
          [77.566169, 12.940796],
          [77.566098, 12.940454],
          [77.565751, 12.940472],
        ],
      ],
    },
    properties: {
      id: "building:133117434",
      campusId: BMSCE_CAMPUS_ID,
      label: "BMSCE Block A",
      heightMeters: 15,
    },
  },
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.566249, 12.941278],
          [77.566298, 12.941515],
          [77.566226, 12.94153],
          [77.566254, 12.941665],
          [77.566509, 12.941615],
          [77.566431, 12.941242],
          [77.566249, 12.941278],
        ],
      ],
    },
    properties: {
      id: "building:133117437",
      campusId: BMSCE_CAMPUS_ID,
      label: "Office Block",
      heightMeters: 18,
    },
  },
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.56653, 12.942165],
          [77.566571, 12.942396],
          [77.566614, 12.942389],
          [77.566631, 12.942486],
          [77.566857, 12.942448],
          [77.566835, 12.942325],
          [77.566805, 12.94233],
          [77.566769, 12.942125],
          [77.56653, 12.942165],
        ],
      ],
    },
    properties: {
      id: "building:133117440",
      campusId: BMSCE_CAMPUS_ID,
      label: "BMS College Of Architecture",
      heightMeters: 18,
    },
  },
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.565263, 12.942096],
          [77.565349, 12.942609],
          [77.565589, 12.942571],
          [77.565504, 12.942058],
          [77.565263, 12.942096],
        ],
      ],
    },
    properties: {
      id: "building:133117446",
      campusId: BMSCE_CAMPUS_ID,
      label: "Mechanical Department",
      heightMeters: 18,
    },
  },
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.566151, 12.941983],
          [77.566283, 12.942561],
          [77.566387, 12.942535],
          [77.56627, 12.941962],
          [77.566151, 12.941983],
        ],
      ],
    },
    properties: {
      id: "building:133117447",
      campusId: BMSCE_CAMPUS_ID,
      label: "Class Room Block",
      heightMeters: 18,
    },
  },
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.565703, 12.942222],
          [77.56576, 12.94252],
          [77.565803, 12.942512],
          [77.565813, 12.942565],
          [77.566041, 12.942524],
          [77.566054, 12.942592],
          [77.565866, 12.942626],
          [77.565878, 12.942687],
          [77.566257, 12.942619],
          [77.566245, 12.942555],
          [77.566082, 12.942585],
          [77.566072, 12.942534],
          [77.566143, 12.942521],
          [77.566073, 12.942155],
          [77.565703, 12.942222],
        ],
      ],
    },
    properties: {
      id: "building:133117448",
      campusId: BMSCE_CAMPUS_ID,
      label: "Computer & Electronics Department",
      heightMeters: 20,
    },
  },
  {
    type: "Feature",
    geometry: {
      type: "Polygon",
      coordinates: [
        [
          [77.565242, 12.941347],
          [77.565615, 12.941296],
          [77.565648, 12.941189],
          [77.565624, 12.941044],
          [77.565557, 12.940977],
          [77.565534, 12.940923],
          [77.565539, 12.940848],
          [77.565578, 12.940763],
          [77.565567, 12.940666],
          [77.56552, 12.940532],
          [77.565065, 12.940587],
          [77.565242, 12.941347],
        ],
      ],
    },
    properties: {
      id: "building:232499237",
      campusId: BMSCE_CAMPUS_ID,
      label: "Platinum Jubilee Academic Block",
      heightMeters: 30,
    },
  },
];

export function buildCampusGeoJSON() {
  return {
    type: "FeatureCollection",
    features: CAMPUS_FEATURES.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        isSelected: 1,
      },
    })),
  };
}

export function buildCampusBuildingGeoJSON() {
  return {
    type: "FeatureCollection",
    features: CAMPUS_BUILDING_FEATURES.map((feature) => ({
      ...feature,
      properties: {
        ...feature.properties,
        isSelected: 1,
      },
    })),
  };
}
