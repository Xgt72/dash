import GPGPU from "./../../GPGPU2.js";
import Car from "../../physics/Car.js";
import xyObstacleGrid from "./gpgpu-programs/xyObstacleGrid.js";
import slObstacleGrid from "./gpgpu-programs/slObstacleGrid.js";
import slObstacleGridDilation from "./gpgpu-programs/slObstacleGridDilation.js";
import xyslMap from "./gpgpu-programs/xyslMap.js";
import optimizeCubicPaths from "./gpgpu-programs/optimizeCubicPaths.js";
import graphSearch from "./gpgpu-programs/graphSearch.js";

const NUM_ACCELERATION_PROFILES = 8;
const NUM_VELOCITY_RANGES = 4;
const NUM_TIME_RANGES = 2;

const config = {
  spatialHorizon: 100, // meters
  stationInterval: 0.5, // meters

  lattice: {
    numStations: 10,
    numLatitudes: 19,
    stationConnectivity: 3,
    latitudeConnectivity: 9
  },

  xyGridCellSize: 0.3, // meters
  slGridCellSize: 0.15, // meters
  gridMargin: 10, // meters
  pathSamplingStep: 0.5, // meters

  lethalDilationS: Car.HALF_CAR_LENGTH + 0.6, // meters
  hazardDilationS: 2, // meters
  lethalDilationL: Car.HALF_CAR_WIDTH + 0.3, //meters
  hazardDilationL: 1, // meters

  obstacleHazardCost: 1,

  laneWidth: 3.7, // meters
  laneShoulderCost: 5,
  laneShoulderLatitude: 3.7 / 2 - Car.HALF_CAR_WIDTH,
  laneCostSlope: 0.5, // cost / meter

  stationReachDiscount: -1,
  extraTimePenalty: 1
};

/* Obstacle cost map:
 *
 * 1. Rasterize triangles from polygonal obstacles into XY-space occupancy grid
 * 2. Convert occupancy grid to SL-space
 *    * Width is spatial horizon of the state lattice
 *    * Height is lane width
 *    * Resolution should be higher than XY-grid
 *    * Get XY position from centerline texture
 *    * Lookup XY in XY occupancy grid (nearest)
 * 3. Dilate SL-space grid using two passes (along station, then along latitude)
 *    * lethal area: half car size + 0.3m
 *    * high cost area: 1 meter
 * 4. Convert back to XY-space using XYSL map
 */

export default class PathPlanner {
  constructor() {
    const programs = [
      xyObstacleGrid.setUp(),
      slObstacleGrid.setUp(),
      ...slObstacleGridDilation.setUp(),
      xyslMap.setUp(),
      optimizeCubicPaths.setUp(),
      graphSearch.setUp()
    ].map(p => Object.assign({}, p, { width: 1, height: 1 }));

    this.gpgpu = new GPGPU(programs);
  }

  plan(lanePath, obstacles) {
    const centerlineRaw = lanePath.sampleStations(0, Math.ceil(config.spatialHorizon / config.stationInterval) + 1, config.stationInterval);

    // Transform all centerline points into vehicle frame
    const vehicleXform = vehicleTransform(centerlineRaw[0]);
    const vehicleRot = centerlineRaw[0].rot;
    const centerline = centerlineRaw.map(c => { return { pos: c.pos.clone().applyMatrix3(vehicleXform), rot: c.rot - vehicleRot, curv: c.curv } });

    const centerlineData = new Float32Array(centerline.length * 3);
    const maxPoint = new THREE.Vector2(0, 0);
    const minPoint = new THREE.Vector2(0, 0);

    for (let i = 0; i < centerline.length; i++) {
      const sample = centerline[i];
      const pos = sample.pos;
      centerlineData[i * 3 + 0] = pos.x;
      centerlineData[i * 3 + 1] = pos.y;
      centerlineData[i * 3 + 2] = sample.rot;

      maxPoint.max(pos);
      minPoint.min(pos);
    }

    const diff = maxPoint.clone().sub(minPoint);
    const xyCenterPoint = minPoint.clone().add(maxPoint).divideScalar(2);
    const xyWidth = Math.ceil((diff.x + config.gridMargin * 2) / config.xyGridCellSize);
    const xyHeight = Math.ceil((diff.y + config.gridMargin * 2) / config.xyGridCellSize);

    const slCenterPoint = new THREE.Vector2(config.spatialHorizon / 2, 0);
    const slWidth = Math.ceil(config.spatialHorizon / config.slGridCellSize);
    const slHeight = Math.ceil((config.laneWidth + config.gridMargin * 2) / config.slGridCellSize);

    for (const [i, p] of [
      xyObstacleGrid.update(config, xyWidth, xyHeight, xyCenterPoint, vehicleXform, obstacles),
      slObstacleGrid.update(config, slWidth, slHeight, slCenterPoint, xyCenterPoint),
      ...slObstacleGridDilation.update(config, slWidth, slHeight),
      xyslMap.update(config, xyWidth, xyHeight, xyCenterPoint),
      optimizeCubicPaths.update(config),
      graphSearch.update(config, xyCenterPoint, slCenterPoint)
    ].entries()) {
      this.gpgpu.updateProgram(i, p);
    }

    this.gpgpu.updateSharedTextures({
      centerline: {
        width: centerline.length,
        height: 1,
        channels: 3,
        filter: 'linear',
        data: centerlineData
      },
      lattice: {
        width: config.lattice.numLatitudes,
        height: config.lattice.numStations,
        channels: 4,
        data: this._buildLattice(lanePath, vehicleRot, vehicleXform)
      },
      costTable: {
        width: NUM_ACCELERATION_PROFILES * NUM_VELOCITY_RANGES * NUM_TIME_RANGES,
        height: config.lattice.numLatitudes,
        depth: config.lattice.numStations,
        channels: 4,
        textureType: '2DArray'
      }
    });

    const outputs = this.gpgpu.run();
    const costTable = this.gpgpu._graphSearchCostTable;

    console.log(costTable);
    let bestEntry = [Number.POSITIVE_INFINITY];
    let bestEntryIndex;
    const numEntries = costTable.length / 4;

    for (let i = config.lattice.numLatitudes * NUM_ACCELERATION_PROFILES * NUM_VELOCITY_RANGES * NUM_TIME_RANGES; i < numEntries; i++) {
      const entryIndex = this._unpackCostTableIndex(i);
      const entry = [
        costTable[i * 4],
        costTable[i * 4 + 1],
        costTable[i * 4 + 2],
        costTable[i * 4 + 3]
      ];

      if (entry[0] == -1) continue;

      entry[0] = this._finalCost(entryIndex, entry);

      if (entry[0] < bestEntry[0]) {
        bestEntryIndex = entryIndex;
        bestEntry = entry;
      }
    }

    console.log(bestEntryIndex, bestEntry);
    console.log(this._unpackCostTableIndex(bestEntry[3]));

    return { xysl: outputs[4], width: xyWidth, height: xyHeight, center: xyCenterPoint.applyMatrix3((new THREE.Matrix3()).getInverse(vehicleXform)), rot: vehicleRot };
  }

  _buildLattice(lanePath, vehicleRot, vehicleXform) {
    const stationInterval = config.spatialHorizon / config.lattice.numStations;
    const centerline = lanePath.sampleStations(stationInterval, config.lattice.numStations, stationInterval);
    const offset = Math.floor(config.lattice.numLatitudes / 2);
    const lattice = new Float32Array(config.lattice.numStations * config.lattice.numLatitudes * 4);
    let index = 0;

    for (let s = 0; s < config.lattice.numStations; s++) {
      const sample = centerline[s];

      for (let l = 0; l < config.lattice.numLatitudes; l++) {
        const latitude = (l - offset) / offset * config.laneWidth / 2;
        const rot = sample.rot - vehicleRot;
        const pos = THREE.Vector2.fromAngle(rot + Math.PI / 2).multiplyScalar(latitude).add(sample.pos.clone().applyMatrix3(vehicleXform));
        const curv = sample.curv == 0 ? 0 : 1 / (1 / sample.curv - latitude);

        lattice[index++] = pos.x;
        lattice[index++] = pos.y;
        lattice[index++] = rot;
        lattice[index++] = curv;
      }
    }

    return lattice;
  }

  _finalCost([stationIndex, latitudeIndex, timeIndex, velocityIndex, accelerationIndex], [cost, finalVelocity, finalTime, incomingIndex]) {
    // Only consider vertices that reach the end of the spatial or temporal horizon
    if (stationIndex != config.lattice.numStations - 1 && finalVelocity > 0.05)
      return Number.POSITIVE_INFINITY;

    const station = (config.spatialHorizon / config.lattice.numStations) * (stationIndex + 1);

    const t = cost + config.stationReachDiscount * station + config.extraTimePenalty * finalTime;
    if (latitudeIndex == 9) {
      console.log([...arguments[0], ...arguments[1]]);
      console.log(this._unpackCostTableIndex(incomingIndex));
    }
    return t;
  }

  _unpackCostTableIndex(index) {
    const numPerTime = NUM_ACCELERATION_PROFILES * NUM_VELOCITY_RANGES;
    const numPerLatitude = numPerTime * NUM_TIME_RANGES;
    const numPerStation = config.lattice.numLatitudes * numPerLatitude;

    const stationIndex = Math.floor(index / numPerStation);
    index -= stationIndex * numPerStation;

    const latitudeIndex = Math.floor(index / numPerLatitude);
    index -= latitudeIndex * numPerLatitude;

    const timeIndex = Math.floor(index / numPerTime);
    index -= timeIndex * numPerTime;

    const velocityIndex = Math.floor(index / NUM_ACCELERATION_PROFILES);
    const accelerationIndex = index % NUM_ACCELERATION_PROFILES;

    return [stationIndex, latitudeIndex, timeIndex, velocityIndex, accelerationIndex];
  }
}

PathPlanner.config = config;

function vehicleTransform({ pos, rot }) {
  const translate = new THREE.Matrix3();
  translate.set(
    1, 0, -pos.x,
    0, 1, -pos.y,
    0, 0, 1
  );

  const cosRot = Math.cos(rot);
  const sinRot = Math.sin(rot);

  const rotate = new THREE.Matrix3();
  rotate.set(
    cosRot, sinRot, 0,
    -sinRot, cosRot, 0,
    0, 0, 1
  );

  return rotate.multiply(translate);
}

function obstacleTransform(vehicleXform, xyCenterPoint, width, height) {
  const translate = new THREE.Matrix3();
  translate.set(
    1, 0, -xyCenterPoint.x,
    0, 1, -xyCenterPoint.y,
    0, 0, 1
  );

  const scale = new THREE.Matrix3();
  scale.set(
    2 / width, 0, 0,
    0, 2 / height, 0,
    0, 0, 1
  );

  return scale.multiply(translate).multiply(vehicleXform);
}
