import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

type SdfVector = readonly [number, number, number];
type SdfTransform = { position?: SdfVector; translation?: SdfVector; rotation?: SdfVector; scale?: SdfVector };
type SdfPrimitive = {
  readonly id: string;
  readonly type: 'sphere' | 'capsule' | 'box' | 'cone' | 'ellipsoid';
  readonly center?: SdfVector;
  readonly radius?: number | SdfVector;
  readonly height?: number;
  readonly size?: SdfVector;
  readonly dimensions?: SdfVector;
  readonly radii?: SdfVector;
  readonly transform?: SdfTransform;
};
type SdfOperation = {
  readonly id?: string;
  readonly output?: string;
  readonly type: 'smooth-union' | 'subtract' | 'intersect';
  readonly left: string;
  readonly right: string;
  readonly radius?: number;
};
type SdfDescriptor = {
  readonly primitives: readonly SdfPrimitive[];
  readonly operations?: readonly SdfOperation[];
  readonly resolution: number;
  readonly bounds?: { readonly min: SdfVector; readonly max: SdfVector };
};
type SdfFunction = (point: THREE.Vector3) => number;

function sdfSphere(point: THREE.Vector3, radius: number): number {
  return point.length() - radius;
}

function sdfCapsule(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const y = Math.max(-halfHeight, Math.min(halfHeight, point.y));
  return point.distanceTo(new THREE.Vector3(0, y, 0)) - radius;
}

function sdfBox(point: THREE.Vector3, size: SdfVector): number {
  const q = new THREE.Vector3(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z))
    .sub(new THREE.Vector3(size[0] * 0.5, size[1] * 0.5, size[2] * 0.5));
  return q.clone().max(new THREE.Vector3()).length() + Math.min(Math.max(q.x, q.y, q.z), 0);
}

function sdfCone(point: THREE.Vector3, radius: number, height: number): number {
  const halfHeight = height * 0.5;
  const taper = radius * (1 - (point.y + halfHeight) / height);
  return Math.max(Math.hypot(point.x, point.z) - Math.max(0, taper), Math.abs(point.y) - halfHeight);
}

function sdfEllipsoid(point: THREE.Vector3, radii: SdfVector): number {
  const scaled = new THREE.Vector3(point.x / radii[0], point.y / radii[1], point.z / radii[2]);
  return (scaled.length() - 1) * Math.min(radii[0], radii[1], radii[2]);
}

function sdfRadii(primitive: SdfPrimitive): SdfVector {
  const radius = primitive.radius;
  if (primitive.radii) return primitive.radii;
  if (typeof radius === 'number') return [radius, radius, radius];
  return radius ?? [0.5, 0.5, 0.5];
}

function smin(left: number, right: number, radius: number): number {
  const blend = Math.max(radius - Math.abs(left - right), 0) / radius;
  return Math.min(left, right) - blend * blend * radius * 0.25;
}

function sdfLocalPoint(point: THREE.Vector3, primitive: SdfPrimitive): { point: THREE.Vector3; scale: number } {
  const transform = primitive.transform;
  const translation = transform?.position ?? transform?.translation ?? primitive.center ?? [0, 0, 0];
  const rotation = transform?.rotation ?? [0, 0, 0];
  const scale = transform?.scale ?? [1, 1, 1];
  const local = point.clone().sub(new THREE.Vector3(translation[0], translation[1], translation[2]));
  const inverseRotation = new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(rotation[0], rotation[1], rotation[2]))
    .invert();
  local.applyQuaternion(inverseRotation);
  local.set(local.x / scale[0], local.y / scale[1], local.z / scale[2]);
  return { point: local, scale: Math.min(scale[0], scale[1], scale[2]) };
}

function sdfPrimitive(point: THREE.Vector3, primitive: SdfPrimitive): number {
  const local = sdfLocalPoint(point, primitive);
  let distance: number;
  switch (primitive.type) {
    case 'sphere':
      distance = sdfSphere(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5);
      break;
    case 'capsule':
      distance = sdfCapsule(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.25, primitive.height ?? 1);
      break;
    case 'box':
      distance = sdfBox(local.point, primitive.size ?? primitive.dimensions ?? [1, 1, 1]);
      break;
    case 'cone':
      distance = sdfCone(local.point, typeof primitive.radius === 'number' ? primitive.radius : 0.5, primitive.height ?? 1);
      break;
    case 'ellipsoid':
      distance = sdfEllipsoid(local.point, sdfRadii(primitive));
      break;
  }
  return distance * local.scale;
}

function sdfSample(descriptor: SdfDescriptor): SdfFunction {
  const nodes = new Map<string, SdfFunction>();
  for (const primitive of descriptor.primitives) nodes.set(primitive.id, (point) => sdfPrimitive(point, primitive));
  let result = descriptor.primitives.length > 0 ? nodes.get(descriptor.primitives[0].id) : undefined;
  for (let index = 0; index < (descriptor.operations?.length ?? 0); index += 1) {
    const operation = descriptor.operations?.[index];
    if (!operation) continue;
    const left = nodes.get(operation.left);
    const right = nodes.get(operation.right);
    if (!left || !right) continue;
    let combined: SdfFunction;
    switch (operation.type) {
      case 'smooth-union':
        combined = (point) => smin(left(point), right(point), operation.radius ?? 0.1);
        break;
      case 'subtract':
        combined = (point) => Math.max(left(point), -right(point));
        break;
      case 'intersect':
        combined = (point) => Math.max(left(point), right(point));
        break;
    }
    nodes.set(operation.id ?? operation.output ?? `operation-${index}`, combined);
    result = combined;
  }
  return result ?? (() => Infinity);
}

function polygonizeSdf(descriptor: SdfDescriptor): THREE.BufferGeometry {
  // SURFACE NETS, not a voxel shell.
  //
  // This used to emit one axis-aligned quad per exposed voxel face, which is a Minecraft surface:
  // every face is axis-aligned, every edge is a 90-degree step, and the result is stair-stepped at
  // exactly the scale of the sampling grid. For a subject whose whole identity is smooth blended
  // organic form -- which is the only kind of subject anyone reaches for an implicit surface to
  // build -- that is worse than the assembled primitives it was meant to replace.
  //
  // Naive surface nets places ONE vertex per sign-changing cell, at the average of the linearly
  // interpolated crossings on that cell's edges, and joins the four cells around each crossing
  // edge into a quad. It is compact, manifold, and smooth, and it is a natural fit for a field
  // that can be sampled anywhere rather than only at corners.
  //
  // Normals come from the field GRADIENT, not from face averaging: the gradient is the exact
  // surface normal of the implicit surface, so shading no longer carries the grid's imprint.
  const resolution = Math.max(4, Math.min(64, Math.floor(descriptor.resolution)));
  const defaultBounds: { readonly min: SdfVector; readonly max: SdfVector } = { min: [-2, -2, -2], max: [2, 2, 2] };
  const bounds = descriptor.bounds ?? defaultBounds;
  const min = new THREE.Vector3(bounds.min[0], bounds.min[1], bounds.min[2]);
  const step = new THREE.Vector3(
    (bounds.max[0] - bounds.min[0]) / resolution,
    (bounds.max[1] - bounds.min[1]) / resolution,
    (bounds.max[2] - bounds.min[2]) / resolution,
  );
  const sample = sdfSample(descriptor);
  const scratch = new THREE.Vector3();

  // Corner grid: one more corner than cells on each axis.
  const side = resolution + 1;
  const field = new Float32Array(side * side * side);
  const cornerAt = (x: number, y: number, z: number): number => (z * side + y) * side + x;
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        scratch.set(min.x + x * step.x, min.y + y * step.y, min.z + z * step.z);
        field[cornerAt(x, y, z)] = sample(scratch);
      }
    }
  }

  // The 12 cell edges as corner-offset pairs.
  const CUBE_EDGES: readonly (readonly [number, number, number, number, number, number])[] = [
    [0, 0, 0, 1, 0, 0], [1, 0, 0, 1, 1, 0], [0, 1, 0, 1, 1, 0], [0, 0, 0, 0, 1, 0],
    [0, 0, 1, 1, 0, 1], [1, 0, 1, 1, 1, 1], [0, 1, 1, 1, 1, 1], [0, 0, 1, 0, 1, 1],
    [0, 0, 0, 0, 0, 1], [1, 0, 0, 1, 0, 1], [1, 1, 0, 1, 1, 1], [0, 1, 0, 0, 1, 1],
  ];

  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  const cellVertex = new Int32Array(resolution * resolution * resolution).fill(-1);
  const cellAt = (x: number, y: number, z: number): number => (z * resolution + y) * resolution + x;

  // Central-difference gradient, stepped at a fraction of a cell so it follows the field rather
  // than the grid.
  const epsilon = Math.min(step.x, step.y, step.z) * 0.25;
  const gradient = (point: THREE.Vector3): THREE.Vector3 => {
    const gx = sample(scratch.set(point.x + epsilon, point.y, point.z))
      - sample(scratch.set(point.x - epsilon, point.y, point.z));
    const gy = sample(scratch.set(point.x, point.y + epsilon, point.z))
      - sample(scratch.set(point.x, point.y - epsilon, point.z));
    const gz = sample(scratch.set(point.x, point.y, point.z + epsilon))
      - sample(scratch.set(point.x, point.y, point.z - epsilon));
    const normal = new THREE.Vector3(gx, gy, gz);
    // A point where the field is flat has no defined normal; +Y is arbitrary but finite, and
    // leaving a zero vector would poison every lighting calculation downstream.
    return normal.lengthSq() < 1e-20 ? new THREE.Vector3(0, 1, 0) : normal.normalize();
  };

  for (let z = 0; z < resolution; z += 1) {
    for (let y = 0; y < resolution; y += 1) {
      for (let x = 0; x < resolution; x += 1) {
        let crossings = 0;
        let sumX = 0;
        let sumY = 0;
        let sumZ = 0;
        for (const [ax, ay, az, bx, by, bz] of CUBE_EDGES) {
          const a = field[cornerAt(x + ax, y + ay, z + az)];
          const b = field[cornerAt(x + bx, y + by, z + bz)];
          if ((a <= 0) === (b <= 0)) continue;
          const t = a / (a - b);
          sumX += (ax + (bx - ax) * t);
          sumY += (ay + (by - ay) * t);
          sumZ += (az + (bz - az) * t);
          crossings += 1;
        }
        if (crossings === 0) continue;
        const px = min.x + (x + sumX / crossings) * step.x;
        const py = min.y + (y + sumY / crossings) * step.y;
        const pz = min.z + (z + sumZ / crossings) * step.z;
        cellVertex[cellAt(x, y, z)] = positions.length / 3;
        positions.push(px, py, pz);
        const normal = gradient(new THREE.Vector3(px, py, pz));
        normals.push(normal.x, normal.y, normal.z);
      }
    }
  }

  // One quad per sign-changing grid edge, joining the four cells that share it.
  //
  // Winding, worked out rather than guessed. For the +x edge from corner (x,y,z), the four cells
  // around it are (x, y-1, z-1), (x, y, z-1), (x, y, z), (x, y-1, z); in the (y,z) plane that
  // traversal is +y, +z, -y, whose cross product is +x. So when the corner is INSIDE and its
  // neighbour is outside, the unflipped order already faces out, and the flip belongs on the
  // opposite case. Getting this backwards is invisible in the normals -- those come from the
  // gradient and stay correct -- and shows only as back-face culling removing the front surface,
  // i.e. the model rendering as a hollow shell with its interior visible.
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return;
    if (flip) indices.push(a, c, b, a, d, c);
    else indices.push(a, b, c, a, c, d);
  };
  // Each quad joins the FOUR cells sharing one grid edge, so every one of those cells must exist.
  // Bounding only the edge axis and the lower end of the other two let y/z reach `resolution`, which
  // is a corner index, not a cell index: `cellAt` then strides into an unrelated slot (with
  // resolution 8, `cellAt(3, 8, 1)` is 131 -- the slot for cell (3, 0, 2)) or past the end of the
  // array, where a typed-array read yields `undefined`. `undefined < 0` is false, so the guard in
  // `quad` passed it through to `setIndex`, which coerces it to 0. Measured on a sphere reaching its
  // own bounds at resolution 8: 60 out-of-range reads and 108 aliased reads. A surface that touches
  // the sampling box is therefore left OPEN at that face rather than closed with wrong triangles --
  // pad `bounds` past the surface to get a closed mesh.
  for (let z = 0; z < side; z += 1) {
    for (let y = 0; y < side; y += 1) {
      for (let x = 0; x < side; x += 1) {
        const here = field[cornerAt(x, y, z)] <= 0;
        if (x + 1 < side && y > 0 && z > 0 && y < side - 1 && z < side - 1
          && here !== (field[cornerAt(x + 1, y, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x, y - 1, z - 1)], cellVertex[cellAt(x, y, z - 1)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y - 1, z)], !here,
          );
        }
        if (y + 1 < side && x > 0 && z > 0 && x < side - 1 && z < side - 1
          && here !== (field[cornerAt(x, y + 1, z)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y, z - 1)], cellVertex[cellAt(x - 1, y, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x, y, z - 1)], !here,
          );
        }
        if (z + 1 < side && x > 0 && y > 0 && x < side - 1 && y < side - 1
          && here !== (field[cornerAt(x, y, z + 1)] <= 0)) {
          quad(
            cellVertex[cellAt(x - 1, y - 1, z)], cellVertex[cellAt(x, y - 1, z)],
            cellVertex[cellAt(x, y, z)], cellVertex[cellAt(x - 1, y, z)], !here,
          );
        }
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

// bevelEnabled defaults to true on THREE.ExtrudeGeometry and rounds every
// corner — sharp/pointed profiles (blades, fork tines, spikes) need
// bevelEnabled: false plus lineTo()-only path segments near the tip, since a
// curve command cannot produce a true converging point.
function buildExtrudeShape(points: [number, number][], holes?: [number, number][][]): THREE.Shape {
  const shape = new THREE.Shape();
  if (points.length > 0) {
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) {
      shape.lineTo(points[i][0], points[i][1]);
    }
  }
  // Cutouts (e.g. an oval wire-cutter hole) as THREE.Path added to shape.holes —
  // dep-free boolean subtraction via the tessellator, no CSG library needed.
  for (const loop of holes ?? []) {
    if (loop.length < 3) continue;
    const path = new THREE.Path();
    path.moveTo(loop[0][0], loop[0][1]);
    for (let i = 1; i < loop.length; i += 1) path.lineTo(loop[i][0], loop[i][1]);
    path.closePath();
    shape.holes.push(path);
  }
  return shape;
}

// Build an N-gon oval loop (for hole authoring from a compact {cx,cy,rx,ry} descriptor).
function ovalLoop(cx: number, cy: number, rx: number, ry: number, seg = 24): [number, number][] {
  const loop: [number, number][] = [];
  for (let i = 0; i < seg; i += 1) {
    const a = (i / seg) * Math.PI * 2;
    loop.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return loop;
}

function buildExtrudeGeometry(profile: { points: [number, number][]; depth: number; holes?: [number, number][][]; ovalHoles?: { cx: number; cy: number; rx: number; ry: number }[] }): THREE.ExtrudeGeometry {
  const holes = [...(profile.holes ?? []), ...((profile.ovalHoles ?? []).map((o) => ovalLoop(o.cx, o.cy, o.rx, o.ry)))];
  const shape = buildExtrudeShape(profile.points, holes);
  return new THREE.ExtrudeGeometry(shape, {
    depth: profile.depth,
    bevelEnabled: false,
    steps: 1,
  });
}

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

function buildTubeGeometry(
  path: { points: [number, number, number][]; radius?: number; radialSegments?: number; closed?: boolean },
): THREE.TubeGeometry {
  const vectors = path.points.map(([x, y, z]) => new THREE.Vector3(x, y, z));
  const curve = new THREE.CatmullRomCurve3(vectors, path.closed ?? false);
  const tubularSegments = Math.max(8, path.points.length * 6);
  return new THREE.TubeGeometry(curve, tubularSegments, path.radius ?? 0.05, path.radialSegments ?? 8, path.closed ?? false);
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Hannya Mask
// Sculpt build pass: blockout
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createHannyaMaskModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Hannya Mask";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["clay-shell"] = createSculptMaterial(
    "clay-shell",
    {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}},
    options
  );
  materialMap["dentition"] = createSculptMaterial(
    "dentition",
    {"id": "dentition", "name": "Fangs and incisors", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#CBC8C3", "color": "#CBC8C3", "albedo": {"dominant": "#CBC8C3", "secondary": ["#B9B6B2"], "samplingNotes": "Teeth read one value step lighter than the shell in the front/below views."}, "colorVariation": {"palette": ["#CBC8C3"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.78, "variation": 0.03, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/dentition_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 2, "texelDensityIntent": "flat"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.01, "role": "none"}], "localOverrides": [{"id": "gumline-ao", "region": "tooth roots where the incisor comb meets the gum bar and fang bases meet the lips", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.82, "aoDarken": 0.3, "notes": "crevice darkening at the dentition roots, visible in the below view"}], "notes": "Slightly lighter and less rough than the shell clay.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/dentition_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r2c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.72, "estimatedFidelity": 0.72, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/dentition_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/dentition_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/dentition_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/dentition_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/dentition_ao.png", "channel": "ao"}}}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const endpoint_mask_shell_0 = makeAttachmentEndpoint(null);
  const node_mask_shell_0 = new THREE.Group();
  node_mask_shell_0.name = "Hollow face shell__pivot";
  node_mask_shell_0.scale.set(1, 1, 1);
  if (endpoint_mask_shell_0) {
    node_mask_shell_0.position.copy(endpoint_mask_shell_0.start);
    node_mask_shell_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_mask_shell_0.position.set(0.0, 0.0, 0.0);
    node_mask_shell_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_mask_shell_0.userData.sculptComponent = {"id": "mask-shell", "name": "Hollow face shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Hollow shell whose OUTER envelope is fitted to the reference silhouettes (front IoU 0.900, top 0.852) rather than authored by eye; inner offset gives the wall, eye and mouth apertures are subtracted through it at measured positions.", "geometryDescriptor": {"topologyIntent": "A thin conforming shell — front half of a head, open posteriorly — built as an implicit field: outer egg (cranium+jaw+brow bulk) minus an inset inner egg gives the wall; eye and mouth apertures are subtracted THROUGH the wall so daylight passes (rear view evidence).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "cranium", "type": "ellipsoid", "center": [0, 0.1595, 0.105], "radii": [0.4307, 0.5531, 0.4706]}, {"id": "jaw", "type": "ellipsoid", "center": [0, -0.3772, 0.081], "radii": [0.3906, 0.4803, 0.3375]}, {"id": "brow", "type": "ellipsoid", "center": [0, 0.12, 0.14], "radii": [0.4504, 0.3, 0.24]}, {"id": "inCran", "type": "ellipsoid", "center": [0, 0.1595, 0.0675], "radii": [0.3557, 0.4781, 0.3956]}, {"id": "inJaw", "type": "ellipsoid", "center": [0, -0.3772, 0.0435], "radii": [0.3156, 0.4053, 0.2625]}, {"id": "eyeL", "type": "ellipsoid", "center": [0.233, -0.038, 0.42], "radii": [0.183, 0.102, 0.45], "transform": {"rotation": [0, 0, 0.2]}}, {"id": "eyeR", "type": "ellipsoid", "center": [-0.233, -0.038, 0.42], "radii": [0.183, 0.102, 0.45], "transform": {"rotation": [0, 0, -0.2]}}, {"id": "mouth", "type": "ellipsoid", "center": [0, -0.635, 0.34], "radii": [0.268, 0.096, 0.42]}, {"id": "mouthCL", "type": "ellipsoid", "center": [0.2198, -0.58, 0.32], "radii": [0.1, 0.075, 0.4]}, {"id": "mouthCR", "type": "ellipsoid", "center": [-0.2198, -0.58, 0.32], "radii": [0.1, 0.075, 0.4]}], "operations": [{"id": "o1", "type": "smooth-union", "left": "cranium", "right": "jaw", "radius": 0.18}, {"id": "outer", "type": "smooth-union", "left": "o1", "right": "brow", "radius": 0.14}, {"id": "inner", "type": "smooth-union", "left": "inCran", "right": "inJaw", "radius": 0.18}, {"id": "wall", "type": "subtract", "left": "outer", "right": "inner"}, {"id": "m1", "type": "smooth-union", "left": "mouth", "right": "mouthCL", "radius": 0.05}, {"id": "m2", "type": "smooth-union", "left": "m1", "right": "mouthCR", "radius": 0.05}, {"id": "c1", "type": "subtract", "left": "wall", "right": "eyeL"}, {"id": "c2", "type": "subtract", "left": "c1", "right": "eyeR"}, {"id": "final", "type": "subtract", "left": "c2", "right": "m2"}], "resolution": 64, "bounds": {"min": [-0.7, -0.92, -0.42], "max": [0.7, 0.78, 0.62]}}}, "parent": null, "attachment": null, "dimensions": {"width": 0.861, "height": 1.57, "depth": 1.04, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "eye-aperture-l", "kind": "hole", "description": "Left almond through-cut, outer canthus raised (+0.22 rad cant)", "evidenceRegion": "front"}, {"id": "eye-aperture-r", "kind": "hole", "description": "Right almond through-cut — reflection of eye-aperture-l", "evidenceRegion": "front"}, {"id": "mouth-aperture", "kind": "hole", "description": "Wide grimace through-cut, corners raised", "evidenceRegion": "front"}, {"id": "glabella-facet", "kind": "bevel", "description": "Flat faceted plane between the brows, hard creases (carried by glabella-plate)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "rear", "profile"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_mask_shell_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["root"] ?? root).add(node_mask_shell_0);
  nodes["mask-shell"] = node_mask_shell_0;
  const mesh_mask_shell_0Geometry = polygonizeSdf({"primitives": [{"id": "cranium", "type": "ellipsoid", "center": [0, 0.1595, 0.105], "radii": [0.4307, 0.5531, 0.4706]}, {"id": "jaw", "type": "ellipsoid", "center": [0, -0.3772, 0.081], "radii": [0.3906, 0.4803, 0.3375]}, {"id": "brow", "type": "ellipsoid", "center": [0, 0.12, 0.14], "radii": [0.4504, 0.3, 0.24]}, {"id": "inCran", "type": "ellipsoid", "center": [0, 0.1595, 0.0675], "radii": [0.3557, 0.4781, 0.3956]}, {"id": "inJaw", "type": "ellipsoid", "center": [0, -0.3772, 0.0435], "radii": [0.3156, 0.4053, 0.2625]}, {"id": "eyeL", "type": "ellipsoid", "center": [0.233, -0.038, 0.42], "radii": [0.183, 0.102, 0.45], "transform": {"rotation": [0, 0, 0.2]}}, {"id": "eyeR", "type": "ellipsoid", "center": [-0.233, -0.038, 0.42], "radii": [0.183, 0.102, 0.45], "transform": {"rotation": [0, 0, -0.2]}}, {"id": "mouth", "type": "ellipsoid", "center": [0, -0.635, 0.34], "radii": [0.268, 0.096, 0.42]}, {"id": "mouthCL", "type": "ellipsoid", "center": [0.2198, -0.58, 0.32], "radii": [0.1, 0.075, 0.4]}, {"id": "mouthCR", "type": "ellipsoid", "center": [-0.2198, -0.58, 0.32], "radii": [0.1, 0.075, 0.4]}], "operations": [{"id": "o1", "type": "smooth-union", "left": "cranium", "right": "jaw", "radius": 0.18}, {"id": "outer", "type": "smooth-union", "left": "o1", "right": "brow", "radius": 0.14}, {"id": "inner", "type": "smooth-union", "left": "inCran", "right": "inJaw", "radius": 0.18}, {"id": "wall", "type": "subtract", "left": "outer", "right": "inner"}, {"id": "m1", "type": "smooth-union", "left": "mouth", "right": "mouthCL", "radius": 0.05}, {"id": "m2", "type": "smooth-union", "left": "m1", "right": "mouthCR", "radius": 0.05}, {"id": "c1", "type": "subtract", "left": "wall", "right": "eyeL"}, {"id": "c2", "type": "subtract", "left": "c1", "right": "eyeR"}, {"id": "final", "type": "subtract", "left": "c2", "right": "m2"}], "resolution": 64, "bounds": {"min": [-0.7, -0.92, -0.42], "max": [0.7, 0.78, 0.62]}});
  if (!endpoint_mask_shell_0) {
    mesh_mask_shell_0Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_mask_shell_0 = new THREE.Mesh(
    mesh_mask_shell_0Geometry,
    createSculptMaterial("clay-shell", {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}}, options, true)
  );
  mesh_mask_shell_0.name = "Hollow face shell";
  if (endpoint_mask_shell_0) {
    mesh_mask_shell_0.position.copy(endpoint_mask_shell_0.midpoint);
    mesh_mask_shell_0.quaternion.copy(endpoint_mask_shell_0.quaternion);
  }
  mesh_mask_shell_0.castShadow = options.castShadow ?? true;
  mesh_mask_shell_0.receiveShadow = options.receiveShadow ?? true;
  mesh_mask_shell_0.userData.sculptComponent = {"id": "mask-shell", "name": "Hollow face shell", "level": "macro", "role": "body", "importance": 1.0, "confidence": 0.9, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Hollow shell whose OUTER envelope is fitted to the reference silhouettes (front IoU 0.900, top 0.852) rather than authored by eye; inner offset gives the wall, eye and mouth apertures are subtracted through it at measured positions.", "geometryDescriptor": {"topologyIntent": "A thin conforming shell — front half of a head, open posteriorly — built as an implicit field: outer egg (cranium+jaw+brow bulk) minus an inset inner egg gives the wall; eye and mouth apertures are subtracted THROUGH the wall so daylight passes (rear view evidence).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "cranium", "type": "ellipsoid", "center": [0, 0.1595, 0.105], "radii": [0.4307, 0.5531, 0.4706]}, {"id": "jaw", "type": "ellipsoid", "center": [0, -0.3772, 0.081], "radii": [0.3906, 0.4803, 0.3375]}, {"id": "brow", "type": "ellipsoid", "center": [0, 0.12, 0.14], "radii": [0.4504, 0.3, 0.24]}, {"id": "inCran", "type": "ellipsoid", "center": [0, 0.1595, 0.0675], "radii": [0.3557, 0.4781, 0.3956]}, {"id": "inJaw", "type": "ellipsoid", "center": [0, -0.3772, 0.0435], "radii": [0.3156, 0.4053, 0.2625]}, {"id": "eyeL", "type": "ellipsoid", "center": [0.233, -0.038, 0.42], "radii": [0.183, 0.102, 0.45], "transform": {"rotation": [0, 0, 0.2]}}, {"id": "eyeR", "type": "ellipsoid", "center": [-0.233, -0.038, 0.42], "radii": [0.183, 0.102, 0.45], "transform": {"rotation": [0, 0, -0.2]}}, {"id": "mouth", "type": "ellipsoid", "center": [0, -0.635, 0.34], "radii": [0.268, 0.096, 0.42]}, {"id": "mouthCL", "type": "ellipsoid", "center": [0.2198, -0.58, 0.32], "radii": [0.1, 0.075, 0.4]}, {"id": "mouthCR", "type": "ellipsoid", "center": [-0.2198, -0.58, 0.32], "radii": [0.1, 0.075, 0.4]}], "operations": [{"id": "o1", "type": "smooth-union", "left": "cranium", "right": "jaw", "radius": 0.18}, {"id": "outer", "type": "smooth-union", "left": "o1", "right": "brow", "radius": 0.14}, {"id": "inner", "type": "smooth-union", "left": "inCran", "right": "inJaw", "radius": 0.18}, {"id": "wall", "type": "subtract", "left": "outer", "right": "inner"}, {"id": "m1", "type": "smooth-union", "left": "mouth", "right": "mouthCL", "radius": 0.05}, {"id": "m2", "type": "smooth-union", "left": "m1", "right": "mouthCR", "radius": 0.05}, {"id": "c1", "type": "subtract", "left": "wall", "right": "eyeL"}, {"id": "c2", "type": "subtract", "left": "c1", "right": "eyeR"}, {"id": "final", "type": "subtract", "left": "c2", "right": "m2"}], "resolution": 64, "bounds": {"min": [-0.7, -0.92, -0.42], "max": [0.7, 0.78, 0.62]}}}, "parent": null, "attachment": null, "dimensions": {"width": 0.861, "height": 1.57, "depth": 1.04, "units": "relative", "confidence": 0.9}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "eye-aperture-l", "kind": "hole", "description": "Left almond through-cut, outer canthus raised (+0.22 rad cant)", "evidenceRegion": "front"}, {"id": "eye-aperture-r", "kind": "hole", "description": "Right almond through-cut — reflection of eye-aperture-l", "evidenceRegion": "front"}, {"id": "mouth-aperture", "kind": "hole", "description": "Wide grimace through-cut, corners raised", "evidenceRegion": "front"}, {"id": "glabella-facet", "kind": "bevel", "description": "Flat faceted plane between the brows, hard creases (carried by glabella-plate)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "rear", "profile"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_mask_shell_0.add(mesh_mask_shell_0);
  meshes["mask-shell"] = mesh_mask_shell_0;
  colliders["mask-shell"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_mask_shell_0);

  const endpoint_horn_l_1 = makeAttachmentEndpoint(null);
  const node_horn_l_1 = new THREE.Group();
  node_horn_l_1.name = "Horn (left)__pivot";
  node_horn_l_1.scale.set(1, 1, 1);
  if (endpoint_horn_l_1) {
    node_horn_l_1.position.copy(endpoint_horn_l_1.start);
    node_horn_l_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_horn_l_1.position.set(0.0, 0.0, 0.0);
    node_horn_l_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_horn_l_1.userData.sculptComponent = {"id": "horn-l", "name": "Horn (left)", "level": "macro", "role": "appendage", "importance": 0.95, "confidence": 0.9, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept blade, not a cone: base radius 0.196, taper 0.99, cross-section flattened to 0.50 of its width. Root, control and tip fitted against the horn-only band of the front reference (rows 0-20, where the skull is absent) plus the top view — IoU 0.005 -> 0.855.", "geometryDescriptor": {"topologyIntent": "A swept 3D arc, not a cone: rises and splays laterally (front), leans posteriorly at mid-arc (profile, z dips to -0.10), tip recovers anteriorly (top view, z ends +0.10). Monotonic taper to a true point.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.3781, 0.1602, 0.063], "rx": 0.1958, "rz": 0.0977, "twist": 0.0}, {"position": [0.4676, 0.274, 0.0391], "rx": 0.1743, "rz": 0.0869, "twist": 0.0}, {"position": [0.5493, 0.3822, 0.0155], "rx": 0.1527, "rz": 0.0761, "twist": 0.0}, {"position": [0.6231, 0.4848, -0.0078], "rx": 0.131, "rz": 0.0653, "twist": 0.0}, {"position": [0.6891, 0.5818, -0.0307], "rx": 0.1094, "rz": 0.0546, "twist": 0.0}, {"position": [0.7471, 0.6732, -0.0533], "rx": 0.0877, "rz": 0.0437, "twist": 0.0}, {"position": [0.7973, 0.759, -0.0756], "rx": 0.0659, "rz": 0.0329, "twist": 0.0}, {"position": [0.8397, 0.8392, -0.0976], "rx": 0.0441, "rz": 0.022, "twist": 0.0}, {"position": [0.8742, 0.9138, -0.1193], "rx": 0.0222, "rz": 0.0111, "twist": 0.0}, {"position": [0.9008, 0.9827, -0.1406], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "horn-socket-l", "localStart": [0.3781, 0.1602, 0.063], "localEnd": [0.9008, 0.9827, -0.1406], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.06, "gapTolerance": 0.01, "contactNormal": [0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "horn-collar-l", "kind": "seam", "description": "Raised collar ring where the horn seats into the cranium (socket seam, geometry carried by horn-collar-ring-l)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "profile", "top"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_l_1.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_horn_l_1);
  nodes["horn-l"] = node_horn_l_1;
  const mesh_horn_l_1Geometry = endpoint_horn_l_1
    ? new THREE.CylinderGeometry(endpoint_horn_l_1.endRadius, endpoint_horn_l_1.baseRadius, endpoint_horn_l_1.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.3781, 0.1602, 0.063], "rx": 0.1958, "rz": 0.0977, "twist": 0.0}, {"position": [0.4676, 0.274, 0.0391], "rx": 0.1743, "rz": 0.0869, "twist": 0.0}, {"position": [0.5493, 0.3822, 0.0155], "rx": 0.1527, "rz": 0.0761, "twist": 0.0}, {"position": [0.6231, 0.4848, -0.0078], "rx": 0.131, "rz": 0.0653, "twist": 0.0}, {"position": [0.6891, 0.5818, -0.0307], "rx": 0.1094, "rz": 0.0546, "twist": 0.0}, {"position": [0.7471, 0.6732, -0.0533], "rx": 0.0877, "rz": 0.0437, "twist": 0.0}, {"position": [0.7973, 0.759, -0.0756], "rx": 0.0659, "rz": 0.0329, "twist": 0.0}, {"position": [0.8397, 0.8392, -0.0976], "rx": 0.0441, "rz": 0.022, "twist": 0.0}, {"position": [0.8742, 0.9138, -0.1193], "rx": 0.0222, "rz": 0.0111, "twist": 0.0}, {"position": [0.9008, 0.9827, -0.1406], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_horn_l_1) {
    mesh_horn_l_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_l_1 = new THREE.Mesh(
    mesh_horn_l_1Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_l_1.name = "Horn (left)";
  if (endpoint_horn_l_1) {
    mesh_horn_l_1.position.copy(endpoint_horn_l_1.midpoint);
    mesh_horn_l_1.quaternion.copy(endpoint_horn_l_1.quaternion);
  }
  mesh_horn_l_1.castShadow = options.castShadow ?? true;
  mesh_horn_l_1.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_l_1.userData.sculptComponent = {"id": "horn-l", "name": "Horn (left)", "level": "macro", "role": "appendage", "importance": 0.95, "confidence": 0.9, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept blade, not a cone: base radius 0.196, taper 0.99, cross-section flattened to 0.50 of its width. Root, control and tip fitted against the horn-only band of the front reference (rows 0-20, where the skull is absent) plus the top view — IoU 0.005 -> 0.855.", "geometryDescriptor": {"topologyIntent": "A swept 3D arc, not a cone: rises and splays laterally (front), leans posteriorly at mid-arc (profile, z dips to -0.10), tip recovers anteriorly (top view, z ends +0.10). Monotonic taper to a true point.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.3781, 0.1602, 0.063], "rx": 0.1958, "rz": 0.0977, "twist": 0.0}, {"position": [0.4676, 0.274, 0.0391], "rx": 0.1743, "rz": 0.0869, "twist": 0.0}, {"position": [0.5493, 0.3822, 0.0155], "rx": 0.1527, "rz": 0.0761, "twist": 0.0}, {"position": [0.6231, 0.4848, -0.0078], "rx": 0.131, "rz": 0.0653, "twist": 0.0}, {"position": [0.6891, 0.5818, -0.0307], "rx": 0.1094, "rz": 0.0546, "twist": 0.0}, {"position": [0.7471, 0.6732, -0.0533], "rx": 0.0877, "rz": 0.0437, "twist": 0.0}, {"position": [0.7973, 0.759, -0.0756], "rx": 0.0659, "rz": 0.0329, "twist": 0.0}, {"position": [0.8397, 0.8392, -0.0976], "rx": 0.0441, "rz": 0.022, "twist": 0.0}, {"position": [0.8742, 0.9138, -0.1193], "rx": 0.0222, "rz": 0.0111, "twist": 0.0}, {"position": [0.9008, 0.9827, -0.1406], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "horn-socket-l", "localStart": [0.3781, 0.1602, 0.063], "localEnd": [0.9008, 0.9827, -0.1406], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.06, "gapTolerance": 0.01, "contactNormal": [0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "horn-collar-l", "kind": "seam", "description": "Raised collar ring where the horn seats into the cranium (socket seam, geometry carried by horn-collar-ring-l)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "profile", "top"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_l_1.add(mesh_horn_l_1);
  meshes["horn-l"] = mesh_horn_l_1;
  colliders["horn-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_horn_l_1);

  const endpoint_horn_r_2 = makeAttachmentEndpoint(null);
  const node_horn_r_2 = new THREE.Group();
  node_horn_r_2.name = "Horn (right)__pivot";
  node_horn_r_2.scale.set(1, 1, 1);
  if (endpoint_horn_r_2) {
    node_horn_r_2.position.copy(endpoint_horn_r_2.start);
    node_horn_r_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_horn_r_2.position.set(0.0, 0.0, 0.0);
    node_horn_r_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_horn_r_2.userData.sculptComponent = {"id": "horn-r", "name": "Horn (right)", "level": "macro", "role": "appendage", "importance": 0.95, "confidence": 0.9, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept blade, not a cone: base radius 0.196, taper 0.99, cross-section flattened to 0.50 of its width. Root, control and tip fitted against the horn-only band of the front reference (rows 0-20, where the skull is absent) plus the top view — IoU 0.005 -> 0.855.", "geometryDescriptor": {"topologyIntent": "A swept 3D arc, not a cone: rises and splays laterally (front), leans posteriorly at mid-arc (profile, z dips to -0.10), tip recovers anteriorly (top view, z ends +0.10). Monotonic taper to a true point.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [-0.3781, 0.1602, 0.063], "rx": 0.1958, "rz": 0.0977, "twist": 0.0}, {"position": [-0.4676, 0.274, 0.0391], "rx": 0.1743, "rz": 0.0869, "twist": 0.0}, {"position": [-0.5493, 0.3822, 0.0155], "rx": 0.1527, "rz": 0.0761, "twist": 0.0}, {"position": [-0.6231, 0.4848, -0.0078], "rx": 0.131, "rz": 0.0653, "twist": 0.0}, {"position": [-0.6891, 0.5818, -0.0307], "rx": 0.1094, "rz": 0.0546, "twist": 0.0}, {"position": [-0.7471, 0.6732, -0.0533], "rx": 0.0877, "rz": 0.0437, "twist": 0.0}, {"position": [-0.7973, 0.759, -0.0756], "rx": 0.0659, "rz": 0.0329, "twist": 0.0}, {"position": [-0.8397, 0.8392, -0.0976], "rx": 0.0441, "rz": 0.022, "twist": 0.0}, {"position": [-0.8742, 0.9138, -0.1193], "rx": 0.0222, "rz": 0.0111, "twist": 0.0}, {"position": [-0.9008, 0.9827, -0.1406], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "horn-socket-r", "localStart": [-0.3781, 0.1602, 0.063], "localEnd": [-0.9008, 0.9827, -0.1406], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.06, "gapTolerance": 0.01, "contactNormal": [-0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "horn-collar-r", "kind": "seam", "description": "Raised collar ring where the horn seats into the cranium (socket seam, geometry carried by horn-collar-ring-r)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "profile", "top"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_r_2.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_horn_r_2);
  nodes["horn-r"] = node_horn_r_2;
  const mesh_horn_r_2Geometry = endpoint_horn_r_2
    ? new THREE.CylinderGeometry(endpoint_horn_r_2.endRadius, endpoint_horn_r_2.baseRadius, endpoint_horn_r_2.length, 32, 12)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.3781, 0.1602, 0.063], "rx": 0.1958, "rz": 0.0977, "twist": 0.0}, {"position": [-0.4676, 0.274, 0.0391], "rx": 0.1743, "rz": 0.0869, "twist": 0.0}, {"position": [-0.5493, 0.3822, 0.0155], "rx": 0.1527, "rz": 0.0761, "twist": 0.0}, {"position": [-0.6231, 0.4848, -0.0078], "rx": 0.131, "rz": 0.0653, "twist": 0.0}, {"position": [-0.6891, 0.5818, -0.0307], "rx": 0.1094, "rz": 0.0546, "twist": 0.0}, {"position": [-0.7471, 0.6732, -0.0533], "rx": 0.0877, "rz": 0.0437, "twist": 0.0}, {"position": [-0.7973, 0.759, -0.0756], "rx": 0.0659, "rz": 0.0329, "twist": 0.0}, {"position": [-0.8397, 0.8392, -0.0976], "rx": 0.0441, "rz": 0.022, "twist": 0.0}, {"position": [-0.8742, 0.9138, -0.1193], "rx": 0.0222, "rz": 0.0111, "twist": 0.0}, {"position": [-0.9008, 0.9827, -0.1406], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true});
  if (!endpoint_horn_r_2) {
    mesh_horn_r_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_r_2 = new THREE.Mesh(
    mesh_horn_r_2Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_r_2.name = "Horn (right)";
  if (endpoint_horn_r_2) {
    mesh_horn_r_2.position.copy(endpoint_horn_r_2.midpoint);
    mesh_horn_r_2.quaternion.copy(endpoint_horn_r_2.quaternion);
  }
  mesh_horn_r_2.castShadow = options.castShadow ?? true;
  mesh_horn_r_2.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_r_2.userData.sculptComponent = {"id": "horn-r", "name": "Horn (right)", "level": "macro", "role": "appendage", "importance": 0.95, "confidence": 0.9, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Swept blade, not a cone: base radius 0.196, taper 0.99, cross-section flattened to 0.50 of its width. Root, control and tip fitted against the horn-only band of the front reference (rows 0-20, where the skull is absent) plus the top view — IoU 0.005 -> 0.855.", "geometryDescriptor": {"topologyIntent": "A swept 3D arc, not a cone: rises and splays laterally (front), leans posteriorly at mid-arc (profile, z dips to -0.10), tip recovers anteriorly (top view, z ends +0.10). Monotonic taper to a true point.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [-0.3781, 0.1602, 0.063], "rx": 0.1958, "rz": 0.0977, "twist": 0.0}, {"position": [-0.4676, 0.274, 0.0391], "rx": 0.1743, "rz": 0.0869, "twist": 0.0}, {"position": [-0.5493, 0.3822, 0.0155], "rx": 0.1527, "rz": 0.0761, "twist": 0.0}, {"position": [-0.6231, 0.4848, -0.0078], "rx": 0.131, "rz": 0.0653, "twist": 0.0}, {"position": [-0.6891, 0.5818, -0.0307], "rx": 0.1094, "rz": 0.0546, "twist": 0.0}, {"position": [-0.7471, 0.6732, -0.0533], "rx": 0.0877, "rz": 0.0437, "twist": 0.0}, {"position": [-0.7973, 0.759, -0.0756], "rx": 0.0659, "rz": 0.0329, "twist": 0.0}, {"position": [-0.8397, 0.8392, -0.0976], "rx": 0.0441, "rz": 0.022, "twist": 0.0}, {"position": [-0.8742, 0.9138, -0.1193], "rx": 0.0222, "rz": 0.0111, "twist": 0.0}, {"position": [-0.9008, 0.9827, -0.1406], "rx": 0.0, "rz": 0.0, "twist": 0.0}], "radialSegments": 14, "capEnds": true}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "horn-socket-r", "localStart": [-0.3781, 0.1602, 0.063], "localEnd": [-0.9008, 0.9827, -0.1406], "contactType": "socket", "embedDepth": 0.06, "overlap": 0.06, "gapTolerance": 0.01, "contactNormal": [-0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "horn-collar-r", "kind": "seam", "description": "Raised collar ring where the horn seats into the cranium (socket seam, geometry carried by horn-collar-ring-r)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "profile", "top"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_r_2.add(mesh_horn_r_2);
  meshes["horn-r"] = mesh_horn_r_2;
  colliders["horn-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_horn_r_2);

  const endpoint_ear_l_3 = makeAttachmentEndpoint(null);
  const node_ear_l_3 = new THREE.Group();
  node_ear_l_3.name = "Pointed ear (l)__pivot";
  node_ear_l_3.scale.set(1, 1, 1);
  if (endpoint_ear_l_3) {
    node_ear_l_3.position.copy(endpoint_ear_l_3.start);
    node_ear_l_3.rotation.set(0.1, 0.28, 0.16);
  } else {
    node_ear_l_3.position.set(0.4085, -0.0711, -0.125);
    node_ear_l_3.rotation.set(0.1, 0.28, 0.16);
  }
  node_ear_l_3.userData.sculptComponent = {"id": "ear-l", "name": "Pointed ear (l)", "level": "macro", "role": "appendage", "importance": 0.75, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "geometryDescriptor": {"topologyIntent": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "body", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.0952, 0.266, 0.22]}, {"id": "tip", "type": "cone", "center": [0, 0.28595000000000004, -0.01], "radius": 0.0904, "height": 0.2826}, {"id": "concha", "type": "sphere", "center": [0.0285, -0.0599, 0.099], "radius": 0.1144}], "operations": [{"id": "b", "type": "smooth-union", "left": "body", "right": "tip", "radius": 0.05}, {"id": "final", "type": "subtract", "left": "b", "right": "concha"}], "resolution": 40, "bounds": {"min": [-0.181, -0.499, -0.418], "max": [0.181, 0.632, 0.418]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "ear-socket-l", "localStart": [0, 0, 0], "localEnd": [0.06, 0, 0], "contactType": "embed", "embedDepth": 0.07, "overlap": 0.07, "gapTolerance": 0.01, "contactNormal": [1, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.45, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.4085, -0.0711, -0.125], "rotation": [0.1, 0.28, 0.16], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "helix-relief-l", "kind": "ridge", "description": "Helix/antihelix relief; concha carved as real negative volume", "evidenceRegion": "profile"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["profile", "front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_ear_l_3.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_ear_l_3);
  nodes["ear-l"] = node_ear_l_3;
  const mesh_ear_l_3Geometry = polygonizeSdf({"primitives": [{"id": "body", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.0952, 0.266, 0.22]}, {"id": "tip", "type": "cone", "center": [0, 0.28595000000000004, -0.01], "radius": 0.0904, "height": 0.2826}, {"id": "concha", "type": "sphere", "center": [0.0285, -0.0599, 0.099], "radius": 0.1144}], "operations": [{"id": "b", "type": "smooth-union", "left": "body", "right": "tip", "radius": 0.05}, {"id": "final", "type": "subtract", "left": "b", "right": "concha"}], "resolution": 40, "bounds": {"min": [-0.181, -0.499, -0.418], "max": [0.181, 0.632, 0.418]}});
  if (!endpoint_ear_l_3) {
    mesh_ear_l_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ear_l_3 = new THREE.Mesh(
    mesh_ear_l_3Geometry,
    createSculptMaterial("clay-shell", {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}}, options, true)
  );
  mesh_ear_l_3.name = "Pointed ear (l)";
  if (endpoint_ear_l_3) {
    mesh_ear_l_3.position.copy(endpoint_ear_l_3.midpoint);
    mesh_ear_l_3.quaternion.copy(endpoint_ear_l_3.quaternion);
  }
  mesh_ear_l_3.castShadow = options.castShadow ?? true;
  mesh_ear_l_3.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_l_3.userData.sculptComponent = {"id": "ear-l", "name": "Pointed ear (l)", "level": "macro", "role": "appendage", "importance": 0.75, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "geometryDescriptor": {"topologyIntent": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "body", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.0952, 0.266, 0.22]}, {"id": "tip", "type": "cone", "center": [0, 0.28595000000000004, -0.01], "radius": 0.0904, "height": 0.2826}, {"id": "concha", "type": "sphere", "center": [0.0285, -0.0599, 0.099], "radius": 0.1144}], "operations": [{"id": "b", "type": "smooth-union", "left": "body", "right": "tip", "radius": 0.05}, {"id": "final", "type": "subtract", "left": "b", "right": "concha"}], "resolution": 40, "bounds": {"min": [-0.181, -0.499, -0.418], "max": [0.181, 0.632, 0.418]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "ear-socket-l", "localStart": [0, 0, 0], "localEnd": [0.06, 0, 0], "contactType": "embed", "embedDepth": 0.07, "overlap": 0.07, "gapTolerance": 0.01, "contactNormal": [1, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.45, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.4085, -0.0711, -0.125], "rotation": [0.1, 0.28, 0.16], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "helix-relief-l", "kind": "ridge", "description": "Helix/antihelix relief; concha carved as real negative volume", "evidenceRegion": "profile"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["profile", "front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_ear_l_3.add(mesh_ear_l_3);
  meshes["ear-l"] = mesh_ear_l_3;
  colliders["ear-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_ear_l_3);

  const endpoint_ear_r_4 = makeAttachmentEndpoint(null);
  const node_ear_r_4 = new THREE.Group();
  node_ear_r_4.name = "Pointed ear (r)__pivot";
  node_ear_r_4.scale.set(1, 1, 1);
  if (endpoint_ear_r_4) {
    node_ear_r_4.position.copy(endpoint_ear_r_4.start);
    node_ear_r_4.rotation.set(0.1, -0.28, -0.16);
  } else {
    node_ear_r_4.position.set(-0.4085, -0.0711, -0.125);
    node_ear_r_4.rotation.set(0.1, -0.28, -0.16);
  }
  node_ear_r_4.userData.sculptComponent = {"id": "ear-r", "name": "Pointed ear (r)", "level": "macro", "role": "appendage", "importance": 0.75, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "geometryDescriptor": {"topologyIntent": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "body", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.0952, 0.266, 0.22]}, {"id": "tip", "type": "cone", "center": [0, 0.28595000000000004, -0.01], "radius": 0.0904, "height": 0.2826}, {"id": "concha", "type": "sphere", "center": [-0.0285, -0.0599, 0.099], "radius": 0.1144}], "operations": [{"id": "b", "type": "smooth-union", "left": "body", "right": "tip", "radius": 0.05}, {"id": "final", "type": "subtract", "left": "b", "right": "concha"}], "resolution": 40, "bounds": {"min": [-0.181, -0.499, -0.418], "max": [0.181, 0.632, 0.418]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "ear-socket-r", "localStart": [0, 0, 0], "localEnd": [-0.06, 0, 0], "contactType": "embed", "embedDepth": 0.07, "overlap": 0.07, "gapTolerance": 0.01, "contactNormal": [-1, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.45, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.4085, -0.0711, -0.125], "rotation": [0.1, -0.28, -0.16], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "helix-relief-r", "kind": "ridge", "description": "Helix/antihelix relief; concha carved as real negative volume", "evidenceRegion": "profile"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["profile", "front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_ear_r_4.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_ear_r_4);
  nodes["ear-r"] = node_ear_r_4;
  const mesh_ear_r_4Geometry = polygonizeSdf({"primitives": [{"id": "body", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.0952, 0.266, 0.22]}, {"id": "tip", "type": "cone", "center": [0, 0.28595000000000004, -0.01], "radius": 0.0904, "height": 0.2826}, {"id": "concha", "type": "sphere", "center": [-0.0285, -0.0599, 0.099], "radius": 0.1144}], "operations": [{"id": "b", "type": "smooth-union", "left": "body", "right": "tip", "radius": 0.05}, {"id": "final", "type": "subtract", "left": "b", "right": "concha"}], "resolution": 40, "bounds": {"min": [-0.181, -0.499, -0.418], "max": [0.181, 0.632, 0.418]}});
  if (!endpoint_ear_r_4) {
    mesh_ear_r_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_ear_r_4 = new THREE.Mesh(
    mesh_ear_r_4Geometry,
    createSculptMaterial("clay-shell", {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}}, options, true)
  );
  mesh_ear_r_4.name = "Pointed ear (r)";
  if (endpoint_ear_r_4) {
    mesh_ear_r_4.position.copy(endpoint_ear_r_4.midpoint);
    mesh_ear_r_4.quaternion.copy(endpoint_ear_r_4.quaternion);
  }
  mesh_ear_r_4.castShadow = options.castShadow ?? true;
  mesh_ear_r_4.receiveShadow = options.receiveShadow ?? true;
  mesh_ear_r_4.userData.sculptComponent = {"id": "ear-r", "name": "Pointed ear (r)", "level": "macro", "role": "appendage", "importance": 0.75, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "geometryDescriptor": {"topologyIntent": "Pointed elf-like ear embedded in the lateral wall, raked posteriorly; concha carved as a subtracted sphere so the relief is real geometry, not shading.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "body", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.0952, 0.266, 0.22]}, {"id": "tip", "type": "cone", "center": [0, 0.28595000000000004, -0.01], "radius": 0.0904, "height": 0.2826}, {"id": "concha", "type": "sphere", "center": [-0.0285, -0.0599, 0.099], "radius": 0.1144}], "operations": [{"id": "b", "type": "smooth-union", "left": "body", "right": "tip", "radius": 0.05}, {"id": "final", "type": "subtract", "left": "b", "right": "concha"}], "resolution": 40, "bounds": {"min": [-0.181, -0.499, -0.418], "max": [0.181, 0.632, 0.418]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "ear-socket-r", "localStart": [0, 0, 0], "localEnd": [-0.06, 0, 0], "contactType": "embed", "embedDepth": 0.07, "overlap": 0.07, "gapTolerance": 0.01, "contactNormal": [-1, 0, 0]}, "dimensions": {"width": 0.2, "height": 0.45, "depth": 0.25, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.4085, -0.0711, -0.125], "rotation": [0.1, -0.28, -0.16], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "helix-relief-r", "kind": "ridge", "description": "Helix/antihelix relief; concha carved as real negative volume", "evidenceRegion": "profile"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["profile", "front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_ear_r_4.add(mesh_ear_r_4);
  meshes["ear-r"] = mesh_ear_r_4;
  colliders["ear-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_ear_r_4);

  const endpoint_brow_ridge_l_5 = makeAttachmentEndpoint(null);
  const node_brow_ridge_l_5 = new THREE.Group();
  node_brow_ridge_l_5.name = "Brow ridge (l)__pivot";
  node_brow_ridge_l_5.scale.set(1, 1, 1);
  if (endpoint_brow_ridge_l_5) {
    node_brow_ridge_l_5.position.copy(endpoint_brow_ridge_l_5.start);
    node_brow_ridge_l_5.rotation.set(-0.16, -0.34, 0.3);
  } else {
    node_brow_ridge_l_5.position.set(0.2, 0.14, 0.4915);
    node_brow_ridge_l_5.rotation.set(-0.16, -0.34, 0.3);
  }
  node_brow_ridge_l_5.userData.sculptComponent = {"id": "brow-ridge-l", "name": "Brow ridge (l)", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "geometryDescriptor": {"topologyIntent": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.2, -0.055], [0.2, -0.025], [0.2, 0.055], [-0.2, 0.022]], "depth": 0.13}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "brow-seat-l", "localStart": [0, 0, 0], "localEnd": [0.17, 0.03, 0], "contactType": "overlap", "embedDepth": 0.05, "overlap": 0.05, "gapTolerance": 0.01, "contactNormal": [0, 0.3, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.2, 0.14, 0.4915], "rotation": [-0.16, -0.34, 0.3], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_brow_ridge_l_5.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_brow_ridge_l_5);
  nodes["brow-ridge-l"] = node_brow_ridge_l_5;
  const mesh_brow_ridge_l_5Geometry = endpoint_brow_ridge_l_5
    ? new THREE.CylinderGeometry(endpoint_brow_ridge_l_5.endRadius, endpoint_brow_ridge_l_5.baseRadius, endpoint_brow_ridge_l_5.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.2, -0.055], [0.2, -0.025], [0.2, 0.055], [-0.2, 0.022]], "depth": 0.13});
  if (!endpoint_brow_ridge_l_5) {
    mesh_brow_ridge_l_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brow_ridge_l_5 = new THREE.Mesh(
    mesh_brow_ridge_l_5Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_ridge_l_5.name = "Brow ridge (l)";
  if (endpoint_brow_ridge_l_5) {
    mesh_brow_ridge_l_5.position.copy(endpoint_brow_ridge_l_5.midpoint);
    mesh_brow_ridge_l_5.quaternion.copy(endpoint_brow_ridge_l_5.quaternion);
  }
  mesh_brow_ridge_l_5.castShadow = options.castShadow ?? true;
  mesh_brow_ridge_l_5.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_ridge_l_5.userData.sculptComponent = {"id": "brow-ridge-l", "name": "Brow ridge (l)", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "geometryDescriptor": {"topologyIntent": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.2, -0.055], [0.2, -0.025], [0.2, 0.055], [-0.2, 0.022]], "depth": 0.13}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "brow-seat-l", "localStart": [0, 0, 0], "localEnd": [0.17, 0.03, 0], "contactType": "overlap", "embedDepth": 0.05, "overlap": 0.05, "gapTolerance": 0.01, "contactNormal": [0, 0.3, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.2, 0.14, 0.4915], "rotation": [-0.16, -0.34, 0.3], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_brow_ridge_l_5.add(mesh_brow_ridge_l_5);
  meshes["brow-ridge-l"] = mesh_brow_ridge_l_5;
  colliders["brow-ridge-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_brow_ridge_l_5);

  const endpoint_brow_ridge_r_6 = makeAttachmentEndpoint(null);
  const node_brow_ridge_r_6 = new THREE.Group();
  node_brow_ridge_r_6.name = "Brow ridge (r)__pivot";
  node_brow_ridge_r_6.scale.set(1, 1, 1);
  if (endpoint_brow_ridge_r_6) {
    node_brow_ridge_r_6.position.copy(endpoint_brow_ridge_r_6.start);
    node_brow_ridge_r_6.rotation.set(-0.16, 0.34, -0.3);
  } else {
    node_brow_ridge_r_6.position.set(-0.2, 0.14, 0.4915);
    node_brow_ridge_r_6.rotation.set(-0.16, 0.34, -0.3);
  }
  node_brow_ridge_r_6.userData.sculptComponent = {"id": "brow-ridge-r", "name": "Brow ridge (r)", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "geometryDescriptor": {"topologyIntent": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0.2, 0.022], [-0.2, 0.055], [-0.2, -0.025], [0.2, -0.055]], "depth": 0.13}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "brow-seat-r", "localStart": [0, 0, 0], "localEnd": [-0.17, 0.03, 0], "contactType": "overlap", "embedDepth": 0.05, "overlap": 0.05, "gapTolerance": 0.01, "contactNormal": [0, 0.3, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2, 0.14, 0.4915], "rotation": [-0.16, 0.34, -0.3], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_brow_ridge_r_6.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_brow_ridge_r_6);
  nodes["brow-ridge-r"] = node_brow_ridge_r_6;
  const mesh_brow_ridge_r_6Geometry = endpoint_brow_ridge_r_6
    ? new THREE.CylinderGeometry(endpoint_brow_ridge_r_6.endRadius, endpoint_brow_ridge_r_6.baseRadius, endpoint_brow_ridge_r_6.length, 32, 12)
    : buildExtrudeGeometry({"points": [[0.2, 0.022], [-0.2, 0.055], [-0.2, -0.025], [0.2, -0.055]], "depth": 0.13});
  if (!endpoint_brow_ridge_r_6) {
    mesh_brow_ridge_r_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_brow_ridge_r_6 = new THREE.Mesh(
    mesh_brow_ridge_r_6Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_brow_ridge_r_6.name = "Brow ridge (r)";
  if (endpoint_brow_ridge_r_6) {
    mesh_brow_ridge_r_6.position.copy(endpoint_brow_ridge_r_6.midpoint);
    mesh_brow_ridge_r_6.quaternion.copy(endpoint_brow_ridge_r_6.quaternion);
  }
  mesh_brow_ridge_r_6.castShadow = options.castShadow ?? true;
  mesh_brow_ridge_r_6.receiveShadow = options.receiveShadow ?? true;
  mesh_brow_ridge_r_6.userData.sculptComponent = {"id": "brow-ridge-r", "name": "Brow ridge (r)", "level": "meso", "role": "body", "importance": 0.9, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "geometryDescriptor": {"topologyIntent": "A hard-edged angular prism: the brow reads as distinct facet planes with countable faces, deliberately proud of the organic shell — this faceting IS the expression.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[0.2, 0.022], [-0.2, 0.055], [-0.2, -0.025], [0.2, -0.055]], "depth": 0.13}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "brow-seat-r", "localStart": [0, 0, 0], "localEnd": [-0.17, 0.03, 0], "contactType": "overlap", "embedDepth": 0.05, "overlap": 0.05, "gapTolerance": 0.01, "contactNormal": [0, 0.3, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2, 0.14, 0.4915], "rotation": [-0.16, 0.34, -0.3], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_brow_ridge_r_6.add(mesh_brow_ridge_r_6);
  meshes["brow-ridge-r"] = mesh_brow_ridge_r_6;
  colliders["brow-ridge-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_brow_ridge_r_6);

  const endpoint_glabella_plate_7 = makeAttachmentEndpoint(null);
  const node_glabella_plate_7 = new THREE.Group();
  node_glabella_plate_7.name = "Glabella facet plate__pivot";
  node_glabella_plate_7.scale.set(1, 1, 1);
  if (endpoint_glabella_plate_7) {
    node_glabella_plate_7.position.copy(endpoint_glabella_plate_7.start);
    node_glabella_plate_7.rotation.set(-0.1, 0.0, 0.0);
  } else {
    node_glabella_plate_7.position.set(0.0, 0.06, 0.5479);
    node_glabella_plate_7.rotation.set(-0.1, 0.0, 0.0);
  }
  node_glabella_plate_7.userData.sculptComponent = {"id": "glabella-plate", "name": "Glabella facet plate", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The flat faceted plane between the brows: a pentagonal plate whose hard edges catch light as real creases (detail glabella-facet-creases).", "geometryDescriptor": {"topologyIntent": "The flat faceted plane between the brows: a pentagonal plate whose hard edges catch light as real creases (detail glabella-facet-creases).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.1, 0.0], [-0.05, 0.12], [0.05, 0.12], [0.1, 0.0], [0.0, -0.16]], "depth": 0.05}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "glabella-seat", "localStart": [0, 0, 0], "localEnd": [0, -0.15, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0.1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0.06, 0.5479], "rotation": [-0.1, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_glabella_plate_7.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_glabella_plate_7);
  nodes["glabella-plate"] = node_glabella_plate_7;
  const mesh_glabella_plate_7Geometry = endpoint_glabella_plate_7
    ? new THREE.CylinderGeometry(endpoint_glabella_plate_7.endRadius, endpoint_glabella_plate_7.baseRadius, endpoint_glabella_plate_7.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.1, 0.0], [-0.05, 0.12], [0.05, 0.12], [0.1, 0.0], [0.0, -0.16]], "depth": 0.05});
  if (!endpoint_glabella_plate_7) {
    mesh_glabella_plate_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_glabella_plate_7 = new THREE.Mesh(
    mesh_glabella_plate_7Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_glabella_plate_7.name = "Glabella facet plate";
  if (endpoint_glabella_plate_7) {
    mesh_glabella_plate_7.position.copy(endpoint_glabella_plate_7.midpoint);
    mesh_glabella_plate_7.quaternion.copy(endpoint_glabella_plate_7.quaternion);
  }
  mesh_glabella_plate_7.castShadow = options.castShadow ?? true;
  mesh_glabella_plate_7.receiveShadow = options.receiveShadow ?? true;
  mesh_glabella_plate_7.userData.sculptComponent = {"id": "glabella-plate", "name": "Glabella facet plate", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "The flat faceted plane between the brows: a pentagonal plate whose hard edges catch light as real creases (detail glabella-facet-creases).", "geometryDescriptor": {"topologyIntent": "The flat faceted plane between the brows: a pentagonal plate whose hard edges catch light as real creases (detail glabella-facet-creases).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.1, 0.0], [-0.05, 0.12], [0.05, 0.12], [0.1, 0.0], [0.0, -0.16]], "depth": 0.05}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "glabella-seat", "localStart": [0, 0, 0], "localEnd": [0, -0.15, 0], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0.1, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0.06, 0.5479], "rotation": [-0.1, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_glabella_plate_7.add(mesh_glabella_plate_7);
  meshes["glabella-plate"] = mesh_glabella_plate_7;
  colliders["glabella-plate"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_glabella_plate_7);

  const endpoint_cheekbone_l_8 = makeAttachmentEndpoint(null);
  const node_cheekbone_l_8 = new THREE.Group();
  node_cheekbone_l_8.name = "Cheekbone facet (l)__pivot";
  node_cheekbone_l_8.scale.set(1, 1, 1);
  if (endpoint_cheekbone_l_8) {
    node_cheekbone_l_8.position.copy(endpoint_cheekbone_l_8.start);
    node_cheekbone_l_8.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cheekbone_l_8.position.set(0.26, -0.3, 0.227);
    node_cheekbone_l_8.rotation.set(0.0, 0.0, 0.0);
  }
  node_cheekbone_l_8.userData.sculptComponent = {"id": "cheekbone-l", "name": "Cheekbone facet (l)", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised cheek mass as an implicit flattened ellipsoid embedded in the shell — an applied extrude plate cannot conform to the curved face and reads as a floating slab.", "geometryDescriptor": {"topologyIntent": "Faceted cheek plane wrapping the lateral face; hard creases against the shell.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "mass", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.15, 0.12, 0.09], "transform": {"rotation": [0.05, 0.35, 0.1]}}], "operations": [], "resolution": 26, "bounds": {"min": [-0.22, -0.18, -0.14], "max": [0.22, 0.18, 0.14]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "cheek-seat-l", "localStart": [0, 0, 0], "localEnd": [0.1, 0, 0], "contactType": "overlap", "embedDepth": 0.04, "overlap": 0.04, "gapTolerance": 0.01, "contactNormal": [0.4, 0, 0.9]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.26, -0.3, 0.227], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nasolabial-l", "kind": "ridge", "description": "Fold from the ala to the mouth corner (geometry: nasolabial-ridge-l)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_cheekbone_l_8.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_cheekbone_l_8);
  nodes["cheekbone-l"] = node_cheekbone_l_8;
  const mesh_cheekbone_l_8Geometry = polygonizeSdf({"primitives": [{"id": "mass", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.15, 0.12, 0.09], "transform": {"rotation": [0.05, 0.35, 0.1]}}], "operations": [], "resolution": 26, "bounds": {"min": [-0.22, -0.18, -0.14], "max": [0.22, 0.18, 0.14]}});
  if (!endpoint_cheekbone_l_8) {
    mesh_cheekbone_l_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cheekbone_l_8 = new THREE.Mesh(
    mesh_cheekbone_l_8Geometry,
    createSculptMaterial("clay-shell", {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}}, options, true)
  );
  mesh_cheekbone_l_8.name = "Cheekbone facet (l)";
  if (endpoint_cheekbone_l_8) {
    mesh_cheekbone_l_8.position.copy(endpoint_cheekbone_l_8.midpoint);
    mesh_cheekbone_l_8.quaternion.copy(endpoint_cheekbone_l_8.quaternion);
  }
  mesh_cheekbone_l_8.castShadow = options.castShadow ?? true;
  mesh_cheekbone_l_8.receiveShadow = options.receiveShadow ?? true;
  mesh_cheekbone_l_8.userData.sculptComponent = {"id": "cheekbone-l", "name": "Cheekbone facet (l)", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised cheek mass as an implicit flattened ellipsoid embedded in the shell — an applied extrude plate cannot conform to the curved face and reads as a floating slab.", "geometryDescriptor": {"topologyIntent": "Faceted cheek plane wrapping the lateral face; hard creases against the shell.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "mass", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.15, 0.12, 0.09], "transform": {"rotation": [0.05, 0.35, 0.1]}}], "operations": [], "resolution": 26, "bounds": {"min": [-0.22, -0.18, -0.14], "max": [0.22, 0.18, 0.14]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "cheek-seat-l", "localStart": [0, 0, 0], "localEnd": [0.1, 0, 0], "contactType": "overlap", "embedDepth": 0.04, "overlap": 0.04, "gapTolerance": 0.01, "contactNormal": [0.4, 0, 0.9]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.26, -0.3, 0.227], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nasolabial-l", "kind": "ridge", "description": "Fold from the ala to the mouth corner (geometry: nasolabial-ridge-l)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_cheekbone_l_8.add(mesh_cheekbone_l_8);
  meshes["cheekbone-l"] = mesh_cheekbone_l_8;
  colliders["cheekbone-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_cheekbone_l_8);

  const endpoint_cheekbone_r_9 = makeAttachmentEndpoint(null);
  const node_cheekbone_r_9 = new THREE.Group();
  node_cheekbone_r_9.name = "Cheekbone facet (r)__pivot";
  node_cheekbone_r_9.scale.set(1, 1, 1);
  if (endpoint_cheekbone_r_9) {
    node_cheekbone_r_9.position.copy(endpoint_cheekbone_r_9.start);
    node_cheekbone_r_9.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_cheekbone_r_9.position.set(-0.26, -0.3, 0.227);
    node_cheekbone_r_9.rotation.set(0.0, 0.0, 0.0);
  }
  node_cheekbone_r_9.userData.sculptComponent = {"id": "cheekbone-r", "name": "Cheekbone facet (r)", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised cheek mass as an implicit flattened ellipsoid embedded in the shell — an applied extrude plate cannot conform to the curved face and reads as a floating slab.", "geometryDescriptor": {"topologyIntent": "Faceted cheek plane wrapping the lateral face; hard creases against the shell.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "mass", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.15, 0.12, 0.09], "transform": {"rotation": [0.05, -0.35, -0.1]}}], "operations": [], "resolution": 26, "bounds": {"min": [-0.22, -0.18, -0.14], "max": [0.22, 0.18, 0.14]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "cheek-seat-r", "localStart": [0, 0, 0], "localEnd": [-0.1, 0, 0], "contactType": "overlap", "embedDepth": 0.04, "overlap": 0.04, "gapTolerance": 0.01, "contactNormal": [-0.4, 0, 0.9]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.26, -0.3, 0.227], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nasolabial-r", "kind": "ridge", "description": "Fold from the ala to the mouth corner (geometry: nasolabial-ridge-r)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_cheekbone_r_9.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_cheekbone_r_9);
  nodes["cheekbone-r"] = node_cheekbone_r_9;
  const mesh_cheekbone_r_9Geometry = polygonizeSdf({"primitives": [{"id": "mass", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.15, 0.12, 0.09], "transform": {"rotation": [0.05, -0.35, -0.1]}}], "operations": [], "resolution": 26, "bounds": {"min": [-0.22, -0.18, -0.14], "max": [0.22, 0.18, 0.14]}});
  if (!endpoint_cheekbone_r_9) {
    mesh_cheekbone_r_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_cheekbone_r_9 = new THREE.Mesh(
    mesh_cheekbone_r_9Geometry,
    createSculptMaterial("clay-shell", {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}}, options, true)
  );
  mesh_cheekbone_r_9.name = "Cheekbone facet (r)";
  if (endpoint_cheekbone_r_9) {
    mesh_cheekbone_r_9.position.copy(endpoint_cheekbone_r_9.midpoint);
    mesh_cheekbone_r_9.quaternion.copy(endpoint_cheekbone_r_9.quaternion);
  }
  mesh_cheekbone_r_9.castShadow = options.castShadow ?? true;
  mesh_cheekbone_r_9.receiveShadow = options.receiveShadow ?? true;
  mesh_cheekbone_r_9.userData.sculptComponent = {"id": "cheekbone-r", "name": "Cheekbone facet (r)", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Raised cheek mass as an implicit flattened ellipsoid embedded in the shell — an applied extrude plate cannot conform to the curved face and reads as a floating slab.", "geometryDescriptor": {"topologyIntent": "Faceted cheek plane wrapping the lateral face; hard creases against the shell.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "mass", "type": "ellipsoid", "center": [0, 0, 0], "radii": [0.15, 0.12, 0.09], "transform": {"rotation": [0.05, -0.35, -0.1]}}], "operations": [], "resolution": 26, "bounds": {"min": [-0.22, -0.18, -0.14], "max": [0.22, 0.18, 0.14]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "cheek-seat-r", "localStart": [0, 0, 0], "localEnd": [-0.1, 0, 0], "contactType": "overlap", "embedDepth": 0.04, "overlap": 0.04, "gapTolerance": 0.01, "contactNormal": [-0.4, 0, 0.9]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.26, -0.3, 0.227], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nasolabial-r", "kind": "ridge", "description": "Fold from the ala to the mouth corner (geometry: nasolabial-ridge-r)", "evidenceRegion": "front"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_cheekbone_r_9.add(mesh_cheekbone_r_9);
  meshes["cheekbone-r"] = mesh_cheekbone_r_9;
  colliders["cheekbone-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_cheekbone_r_9);

  const endpoint_nose_wedge_10 = makeAttachmentEndpoint(null);
  const node_nose_wedge_10 = new THREE.Group();
  node_nose_wedge_10.name = "Nose wedge__pivot";
  node_nose_wedge_10.scale.set(1, 1, 1);
  if (endpoint_nose_wedge_10) {
    node_nose_wedge_10.position.copy(endpoint_nose_wedge_10.start);
    node_nose_wedge_10.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nose_wedge_10.position.set(0.0, 0.0, 0.0);
    node_nose_wedge_10.rotation.set(0.0, 0.0, 0.0);
  }
  node_nose_wedge_10.userData.sculptComponent = {"id": "nose-wedge", "name": "Nose wedge", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Anterior wedge: rotated-box bridge continuing the brow crease line, ellipsoid tip, alae spheres; nostrils are SUBTRACTED cavities on the underside (below-view evidence), never dark paint.", "geometryDescriptor": {"topologyIntent": "Anterior wedge: rotated-box bridge continuing the brow crease line, ellipsoid tip, alae spheres; nostrils are SUBTRACTED cavities on the underside (below-view evidence), never dark paint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "bridge", "type": "box", "center": [0, 0.02, 0.3759], "size": [0.11, 0.36, 0.16], "transform": {"rotation": [-0.2, 0, 0]}}, {"id": "tip", "type": "ellipsoid", "center": [0, -0.272, 0.4909], "radii": [0.095, 0.085, 0.095]}, {"id": "alaL", "type": "sphere", "center": [0.092, -0.322, 0.4409], "radius": 0.062}, {"id": "alaR", "type": "sphere", "center": [-0.092, -0.322, 0.4409], "radius": 0.062}, {"id": "nosL", "type": "sphere", "center": [0.062, -0.372, 0.4709], "radius": 0.042}, {"id": "nosR", "type": "sphere", "center": [-0.062, -0.372, 0.4709], "radius": 0.042}], "operations": [{"id": "n1", "type": "smooth-union", "left": "bridge", "right": "tip", "radius": 0.055}, {"id": "n2", "type": "smooth-union", "left": "n1", "right": "alaL", "radius": 0.035}, {"id": "n3", "type": "smooth-union", "left": "n2", "right": "alaR", "radius": 0.035}, {"id": "n4", "type": "subtract", "left": "n3", "right": "nosL"}, {"id": "final", "type": "subtract", "left": "n4", "right": "nosR"}], "resolution": 56, "bounds": {"min": [-0.24, -0.517, 0.136], "max": [0.24, 0.3, 0.636]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "nose-seat", "localStart": [0, 0.18, 0.28], "localEnd": [0, -0.372, 0.4709], "contactType": "overlap", "embedDepth": 0.06, "overlap": 0.06, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.3, "height": 0.55, "depth": 0.35, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nostril-l", "kind": "hole", "description": "Left nostril cavity, flared laterally", "evidenceRegion": "below"}, {"id": "nostril-r", "kind": "hole", "description": "Right nostril cavity — reflection", "evidenceRegion": "below"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "profile", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_nose_wedge_10.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_nose_wedge_10);
  nodes["nose-wedge"] = node_nose_wedge_10;
  const mesh_nose_wedge_10Geometry = polygonizeSdf({"primitives": [{"id": "bridge", "type": "box", "center": [0, 0.02, 0.3759], "size": [0.11, 0.36, 0.16], "transform": {"rotation": [-0.2, 0, 0]}}, {"id": "tip", "type": "ellipsoid", "center": [0, -0.272, 0.4909], "radii": [0.095, 0.085, 0.095]}, {"id": "alaL", "type": "sphere", "center": [0.092, -0.322, 0.4409], "radius": 0.062}, {"id": "alaR", "type": "sphere", "center": [-0.092, -0.322, 0.4409], "radius": 0.062}, {"id": "nosL", "type": "sphere", "center": [0.062, -0.372, 0.4709], "radius": 0.042}, {"id": "nosR", "type": "sphere", "center": [-0.062, -0.372, 0.4709], "radius": 0.042}], "operations": [{"id": "n1", "type": "smooth-union", "left": "bridge", "right": "tip", "radius": 0.055}, {"id": "n2", "type": "smooth-union", "left": "n1", "right": "alaL", "radius": 0.035}, {"id": "n3", "type": "smooth-union", "left": "n2", "right": "alaR", "radius": 0.035}, {"id": "n4", "type": "subtract", "left": "n3", "right": "nosL"}, {"id": "final", "type": "subtract", "left": "n4", "right": "nosR"}], "resolution": 56, "bounds": {"min": [-0.24, -0.517, 0.136], "max": [0.24, 0.3, 0.636]}});
  if (!endpoint_nose_wedge_10) {
    mesh_nose_wedge_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nose_wedge_10 = new THREE.Mesh(
    mesh_nose_wedge_10Geometry,
    createSculptMaterial("clay-shell", {"id": "clay-shell", "name": "Mask shell clay", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B9B6B2", "color": "#B9B6B2", "albedo": {"dominant": "#B9B6B2", "secondary": ["#A8A5A1", "#C6C3BF"], "samplingNotes": "Reference is an achromatic clay preview: single flat albedo; all tonal variation in the reference is lighting."}, "colorVariation": {"palette": ["#B9B6B2"], "pattern": "none", "amplitude": 0.0, "heightCorrelation": 0.0}, "metalness": 0.0, "roughness": {"base": 0.88, "variation": 0.04, "map": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_roughness.png (extracted; near-uniform matte, no specular lobe in the reference)"}, "textureResolution": 1024, "textureProjection": {"mode": "uv", "repeat": [1, 1], "anisotropy": 4, "texelDensityIntent": "flat albedo; no texture detail exists in the reference"}, "surfaceFrequencyBands": [{"id": "macro", "frequency": 1.0, "amplitude": 0.01, "role": "none — flat clay"}, {"id": "meso", "frequency": 4.0, "amplitude": 0.01, "role": "none"}, {"id": "micro", "frequency": 16.0, "amplitude": 0.02, "role": "faint matte breakup"}], "localOverrides": [{"id": "cavity-ao", "region": "eye apertures' inner walls, mouth interior, nostril cavities, ear conchae, the shell interior seen through the rear opening", "dirtAmount": 0.0, "cavityBias": true, "streak": false, "roughness": 0.92, "aoDarken": 0.45, "notes": "no dirt/wear exists on the pristine clay reference; the only regional response is cavity occlusion darkening"}], "notes": "Geometry-only reconstruction: the consuming sandbox replaces materials wholesale.", "ambientOcclusion": {"source": "/Users/dmitriy/new-10/.img2threejs/pbr/clay-shell_ao.png", "response": "cavity-only: concave regions (eye sockets, mouth, nostrils, concha) darken; convex crests stay open", "intensity": 0.6}, "referencePbr": {"version": "1", "sourceImage": "/Users/dmitriy/new-10/.img2threejs/detail-inventory/zone-r1c1.png", "extractor": "forge/stage1_intake/extract_pbr_evidence.py", "method": "single-image statistical inversion on a reference crop", "verdict": "usable", "usable": true, "confidence": 0.742, "estimatedFidelity": 0.742, "targetThreshold": 0.7, "hardLimit": "single-image inverse rendering is an estimate; the reference is an untextured clay preview, so this evidence proves the CLAY look the harness renders are compared against, not a production finish", "maps": {"albedo": {"path": "/.img2threejs/pbr/clay-shell_albedo.png", "channel": "albedo"}, "roughness": {"path": "/.img2threejs/pbr/clay-shell_roughness.png", "channel": "roughness"}, "height": {"path": "/.img2threejs/pbr/clay-shell_height.png", "channel": "height"}, "normal": {"path": "/.img2threejs/pbr/clay-shell_normal.png", "channel": "normal"}, "ao": {"path": "/.img2threejs/pbr/clay-shell_ao.png", "channel": "ao"}}}}, options, true)
  );
  mesh_nose_wedge_10.name = "Nose wedge";
  if (endpoint_nose_wedge_10) {
    mesh_nose_wedge_10.position.copy(endpoint_nose_wedge_10.midpoint);
    mesh_nose_wedge_10.quaternion.copy(endpoint_nose_wedge_10.quaternion);
  }
  mesh_nose_wedge_10.castShadow = options.castShadow ?? true;
  mesh_nose_wedge_10.receiveShadow = options.receiveShadow ?? true;
  mesh_nose_wedge_10.userData.sculptComponent = {"id": "nose-wedge", "name": "Nose wedge", "level": "meso", "role": "body", "importance": 0.85, "confidence": 0.85, "primitive": "ellipsoid", "topologyClass": "implicit", "topologyRationale": "Anterior wedge: rotated-box bridge continuing the brow crease line, ellipsoid tip, alae spheres; nostrils are SUBTRACTED cavities on the underside (below-view evidence), never dark paint.", "geometryDescriptor": {"topologyIntent": "Anterior wedge: rotated-box bridge continuing the brow crease line, ellipsoid tip, alae spheres; nostrils are SUBTRACTED cavities on the underside (below-view evidence), never dark paint.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "sdf": {"primitives": [{"id": "bridge", "type": "box", "center": [0, 0.02, 0.3759], "size": [0.11, 0.36, 0.16], "transform": {"rotation": [-0.2, 0, 0]}}, {"id": "tip", "type": "ellipsoid", "center": [0, -0.272, 0.4909], "radii": [0.095, 0.085, 0.095]}, {"id": "alaL", "type": "sphere", "center": [0.092, -0.322, 0.4409], "radius": 0.062}, {"id": "alaR", "type": "sphere", "center": [-0.092, -0.322, 0.4409], "radius": 0.062}, {"id": "nosL", "type": "sphere", "center": [0.062, -0.372, 0.4709], "radius": 0.042}, {"id": "nosR", "type": "sphere", "center": [-0.062, -0.372, 0.4709], "radius": 0.042}], "operations": [{"id": "n1", "type": "smooth-union", "left": "bridge", "right": "tip", "radius": 0.055}, {"id": "n2", "type": "smooth-union", "left": "n1", "right": "alaL", "radius": 0.035}, {"id": "n3", "type": "smooth-union", "left": "n2", "right": "alaR", "radius": 0.035}, {"id": "n4", "type": "subtract", "left": "n3", "right": "nosL"}, {"id": "final", "type": "subtract", "left": "n4", "right": "nosR"}], "resolution": 56, "bounds": {"min": [-0.24, -0.517, 0.136], "max": [0.24, 0.3, 0.636]}}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "nose-seat", "localStart": [0, 0.18, 0.28], "localEnd": [0, -0.372, 0.4709], "contactType": "overlap", "embedDepth": 0.06, "overlap": 0.06, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 0.3, "height": 0.55, "depth": 0.35, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "nostril-l", "kind": "hole", "description": "Left nostril cavity, flared laterally", "evidenceRegion": "below"}, {"id": "nostril-r", "kind": "hole", "description": "Right nostril cavity — reflection", "evidenceRegion": "below"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "profile", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_nose_wedge_10.add(mesh_nose_wedge_10);
  meshes["nose-wedge"] = mesh_nose_wedge_10;
  colliders["nose-wedge"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_nose_wedge_10);

  const attachment_upper_lip_11 = {"parentId": "mask-shell", "parentSocket": "upper-lip-seat", "localStart": [-0.2573, -0.5072, 0.288], "localEnd": [0.2573, -0.5072, 0.288], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]};
  const endpoint_upper_lip_11 = makeAttachmentEndpoint(attachment_upper_lip_11);
  const node_upper_lip_11 = new THREE.Group();
  node_upper_lip_11.name = "Upper lip__pivot";
  node_upper_lip_11.scale.set(1, 1, 1);
  if (endpoint_upper_lip_11) {
    node_upper_lip_11.position.copy(endpoint_upper_lip_11.start);
    node_upper_lip_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_upper_lip_11.position.set(0.0, 0.0, 0.0);
    node_upper_lip_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_upper_lip_11.userData.sculptComponent = {"id": "upper-lip", "name": "Upper lip", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "tube", "topologyClass": "continuous-sculpt", "topologyRationale": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "geometryDescriptor": {"topologyIntent": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.2573, -0.5072, 0.288], [-0.1415, -0.5602, 0.3381], [0.0, -0.5822, 0.3562], [0.1415, -0.5602, 0.3381], [0.2573, -0.5072, 0.288]], "radius": 0.048, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-seat", "localStart": [-0.2573, -0.5072, 0.288], "localEnd": [0.2573, -0.5072, 0.288], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_upper_lip_11.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_upper_lip_11);
  nodes["upper-lip"] = node_upper_lip_11;
  const mesh_upper_lip_11Geometry = endpoint_upper_lip_11
    ? new THREE.CylinderGeometry(endpoint_upper_lip_11.endRadius, endpoint_upper_lip_11.baseRadius, endpoint_upper_lip_11.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.2573, -0.5072, 0.288], [-0.1415, -0.5602, 0.3381], [0.0, -0.5822, 0.3562], [0.1415, -0.5602, 0.3381], [0.2573, -0.5072, 0.288]], "radius": 0.048, "closed": false});
  if (!endpoint_upper_lip_11) {
    mesh_upper_lip_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_lip_11 = new THREE.Mesh(
    mesh_upper_lip_11Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_lip_11.name = "Upper lip";
  if (endpoint_upper_lip_11) {
    mesh_upper_lip_11.position.copy(endpoint_upper_lip_11.midpoint);
    mesh_upper_lip_11.quaternion.copy(endpoint_upper_lip_11.quaternion);
  }
  mesh_upper_lip_11.castShadow = options.castShadow ?? true;
  mesh_upper_lip_11.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_lip_11.userData.sculptComponent = {"id": "upper-lip", "name": "Upper lip", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "tube", "topologyClass": "continuous-sculpt", "topologyRationale": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "geometryDescriptor": {"topologyIntent": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.2573, -0.5072, 0.288], [-0.1415, -0.5602, 0.3381], [0.0, -0.5822, 0.3562], [0.1415, -0.5602, 0.3381], [0.2573, -0.5072, 0.288]], "radius": 0.048, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-seat", "localStart": [-0.2573, -0.5072, 0.288], "localEnd": [0.2573, -0.5072, 0.288], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_upper_lip_11.add(mesh_upper_lip_11);
  meshes["upper-lip"] = mesh_upper_lip_11;
  colliders["upper-lip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_upper_lip_11);

  const attachment_lower_lip_12 = {"parentId": "mask-shell", "parentSocket": "lower-lip-seat", "localStart": [-0.2573, -0.632, 0.2311], "localEnd": [0.2573, -0.632, 0.2311], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]};
  const endpoint_lower_lip_12 = makeAttachmentEndpoint(attachment_lower_lip_12);
  const node_lower_lip_12 = new THREE.Group();
  node_lower_lip_12.name = "Lower lip__pivot";
  node_lower_lip_12.scale.set(1, 1, 1);
  if (endpoint_lower_lip_12) {
    node_lower_lip_12.position.copy(endpoint_lower_lip_12.start);
    node_lower_lip_12.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_lower_lip_12.position.set(0.0, 0.0, 0.0);
    node_lower_lip_12.rotation.set(0.0, 0.0, 0.0);
  }
  node_lower_lip_12.userData.sculptComponent = {"id": "lower-lip", "name": "Lower lip", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "tube", "topologyClass": "continuous-sculpt", "topologyRationale": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "geometryDescriptor": {"topologyIntent": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.2573, -0.632, 0.2311], [-0.1415, -0.685, 0.2794], [0.0, -0.707, 0.2964], [0.1415, -0.685, 0.2794], [0.2573, -0.632, 0.2311]], "radius": 0.044, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "lower-lip-seat", "localStart": [-0.2573, -0.632, 0.2311], "localEnd": [0.2573, -0.632, 0.2311], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_lower_lip_12.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_lower_lip_12);
  nodes["lower-lip"] = node_lower_lip_12;
  const mesh_lower_lip_12Geometry = endpoint_lower_lip_12
    ? new THREE.CylinderGeometry(endpoint_lower_lip_12.endRadius, endpoint_lower_lip_12.baseRadius, endpoint_lower_lip_12.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.2573, -0.632, 0.2311], [-0.1415, -0.685, 0.2794], [0.0, -0.707, 0.2964], [0.1415, -0.685, 0.2794], [0.2573, -0.632, 0.2311]], "radius": 0.044, "closed": false});
  if (!endpoint_lower_lip_12) {
    mesh_lower_lip_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lower_lip_12 = new THREE.Mesh(
    mesh_lower_lip_12Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lower_lip_12.name = "Lower lip";
  if (endpoint_lower_lip_12) {
    mesh_lower_lip_12.position.copy(endpoint_lower_lip_12.midpoint);
    mesh_lower_lip_12.quaternion.copy(endpoint_lower_lip_12.quaternion);
  }
  mesh_lower_lip_12.castShadow = options.castShadow ?? true;
  mesh_lower_lip_12.receiveShadow = options.receiveShadow ?? true;
  mesh_lower_lip_12.userData.sculptComponent = {"id": "lower-lip", "name": "Lower lip", "level": "meso", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "tube", "topologyClass": "continuous-sculpt", "topologyRationale": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "geometryDescriptor": {"topologyIntent": "A tube swept along the grimace curve — corners pulled up and wrapped posteriorly; frames the mouth aperture cut through the shell behind it.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.2573, -0.632, 0.2311], [-0.1415, -0.685, 0.2794], [0.0, -0.707, 0.2964], [0.1415, -0.685, 0.2794], [0.2573, -0.632, 0.2311]], "radius": 0.044, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "lower-lip-seat", "localStart": [-0.2573, -0.632, 0.2311], "localEnd": [0.2573, -0.632, 0.2311], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 0, 1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_lower_lip_12.add(mesh_lower_lip_12);
  meshes["lower-lip"] = mesh_lower_lip_12;
  colliders["lower-lip"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_lower_lip_12);

  const attachment_posterior_rim_13 = {"parentId": "mask-shell", "parentSocket": "rim-seat", "localStart": [0.4264, 0.1595, -0.162], "localEnd": [-0.4264, 0.1595, -0.2338], "contactType": "flush", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0, 0, -1]};
  const endpoint_posterior_rim_13 = makeAttachmentEndpoint(attachment_posterior_rim_13);
  const node_posterior_rim_13 = new THREE.Group();
  node_posterior_rim_13.name = "Posterior rim__pivot";
  node_posterior_rim_13.scale.set(1, 1, 1);
  if (endpoint_posterior_rim_13) {
    node_posterior_rim_13.position.copy(endpoint_posterior_rim_13.start);
    node_posterior_rim_13.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_posterior_rim_13.position.set(0.0, 0.0, 0.0);
    node_posterior_rim_13.rotation.set(0.0, 0.0, 0.0);
  }
  node_posterior_rim_13.userData.sculptComponent = {"id": "posterior-rim", "name": "Posterior rim", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "The wall-thickness rim terminating the shell — a closed tube loop following the opening edge (cranium apex, behind the ear, around the jaw), matching the rear view's thickened lip.", "geometryDescriptor": {"topologyIntent": "The wall-thickness rim terminating the shell — a closed tube loop following the opening edge (cranium apex, behind the ear, around the jaw), matching the rear view's thickened lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[0.4264, 0.1595, -0.162], [0.3693, 0.4333, -0.2338], [0.2132, 0.6337, -0.2338], [0.0, 0.7071, -0.2338], [-0.2132, 0.6337, -0.2338], [-0.3693, 0.4333, -0.2338], [-0.4264, 0.1595, -0.2338], [-0.3693, -0.6149, -0.162], [-0.2132, -0.789, -0.162], [-0.0, -0.8527, -0.162], [0.2132, -0.789, -0.162], [0.3693, -0.6149, -0.162]], "radius": 0.026, "closed": true}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "rim-seat", "localStart": [0.4264, 0.1595, -0.162], "localEnd": [-0.4264, 0.1595, -0.2338], "contactType": "flush", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0, 0, -1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rim-edge", "kind": "seam", "description": "Continuous closed rim edge; the shell terminates here", "evidenceRegion": "rear"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["rear", "profile"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_posterior_rim_13.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_posterior_rim_13);
  nodes["posterior-rim"] = node_posterior_rim_13;
  const mesh_posterior_rim_13Geometry = endpoint_posterior_rim_13
    ? new THREE.CylinderGeometry(endpoint_posterior_rim_13.endRadius, endpoint_posterior_rim_13.baseRadius, endpoint_posterior_rim_13.length, 32, 12)
    : buildTubeGeometry({"points": [[0.4264, 0.1595, -0.162], [0.3693, 0.4333, -0.2338], [0.2132, 0.6337, -0.2338], [0.0, 0.7071, -0.2338], [-0.2132, 0.6337, -0.2338], [-0.3693, 0.4333, -0.2338], [-0.4264, 0.1595, -0.2338], [-0.3693, -0.6149, -0.162], [-0.2132, -0.789, -0.162], [-0.0, -0.8527, -0.162], [0.2132, -0.789, -0.162], [0.3693, -0.6149, -0.162]], "radius": 0.026, "closed": true});
  if (!endpoint_posterior_rim_13) {
    mesh_posterior_rim_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_posterior_rim_13 = new THREE.Mesh(
    mesh_posterior_rim_13Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_posterior_rim_13.name = "Posterior rim";
  if (endpoint_posterior_rim_13) {
    mesh_posterior_rim_13.position.copy(endpoint_posterior_rim_13.midpoint);
    mesh_posterior_rim_13.quaternion.copy(endpoint_posterior_rim_13.quaternion);
  }
  mesh_posterior_rim_13.castShadow = options.castShadow ?? true;
  mesh_posterior_rim_13.receiveShadow = options.receiveShadow ?? true;
  mesh_posterior_rim_13.userData.sculptComponent = {"id": "posterior-rim", "name": "Posterior rim", "level": "meso", "role": "body", "importance": 0.7, "confidence": 0.8, "primitive": "tube", "topologyClass": "conforming-shell", "topologyRationale": "The wall-thickness rim terminating the shell — a closed tube loop following the opening edge (cranium apex, behind the ear, around the jaw), matching the rear view's thickened lip.", "geometryDescriptor": {"topologyIntent": "The wall-thickness rim terminating the shell — a closed tube loop following the opening edge (cranium apex, behind the ear, around the jaw), matching the rear view's thickened lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[0.4264, 0.1595, -0.162], [0.3693, 0.4333, -0.2338], [0.2132, 0.6337, -0.2338], [0.0, 0.7071, -0.2338], [-0.2132, 0.6337, -0.2338], [-0.3693, 0.4333, -0.2338], [-0.4264, 0.1595, -0.2338], [-0.3693, -0.6149, -0.162], [-0.2132, -0.789, -0.162], [-0.0, -0.8527, -0.162], [0.2132, -0.789, -0.162], [0.3693, -0.6149, -0.162]], "radius": 0.026, "closed": true}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "rim-seat", "localStart": [0.4264, 0.1595, -0.162], "localEnd": [-0.4264, 0.1595, -0.2338], "contactType": "flush", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0, 0, -1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "rim-edge", "kind": "seam", "description": "Continuous closed rim edge; the shell terminates here", "evidenceRegion": "rear"}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["rear", "profile"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_posterior_rim_13.add(mesh_posterior_rim_13);
  meshes["posterior-rim"] = mesh_posterior_rim_13;
  colliders["posterior-rim"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_posterior_rim_13);

  const attachment_nasolabial_ridge_l_14 = {"parentId": "mask-shell", "parentSocket": "fold-seat-l", "localStart": [0.115, -0.297, 0.3786], "localEnd": [0.235, -0.56, 0.298], "contactType": "overlap", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0.3, 0, 0.95]};
  const endpoint_nasolabial_ridge_l_14 = makeAttachmentEndpoint(attachment_nasolabial_ridge_l_14);
  const node_nasolabial_ridge_l_14 = new THREE.Group();
  node_nasolabial_ridge_l_14.name = "Nasolabial fold (l)__pivot";
  node_nasolabial_ridge_l_14.scale.set(1, 1, 1);
  if (endpoint_nasolabial_ridge_l_14) {
    node_nasolabial_ridge_l_14.position.copy(endpoint_nasolabial_ridge_l_14.start);
    node_nasolabial_ridge_l_14.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nasolabial_ridge_l_14.position.set(0.0, 0.0, 0.0);
    node_nasolabial_ridge_l_14.rotation.set(0.0, 0.0, 0.0);
  }
  node_nasolabial_ridge_l_14.userData.sculptComponent = {"id": "nasolabial-ridge-l", "name": "Nasolabial fold (l)", "level": "micro", "role": "body", "importance": 0.5, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "geometryDescriptor": {"topologyIntent": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[0.115, -0.297, 0.3786], [0.175, -0.437, 0.3598], [0.235, -0.56, 0.298]], "radius": 0.018, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "fold-seat-l", "localStart": [0.115, -0.297, 0.3786], "localEnd": [0.235, -0.56, 0.298], "contactType": "overlap", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0.3, 0, 0.95]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_nasolabial_ridge_l_14.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_nasolabial_ridge_l_14);
  nodes["nasolabial-ridge-l"] = node_nasolabial_ridge_l_14;
  const mesh_nasolabial_ridge_l_14Geometry = endpoint_nasolabial_ridge_l_14
    ? new THREE.CylinderGeometry(endpoint_nasolabial_ridge_l_14.endRadius, endpoint_nasolabial_ridge_l_14.baseRadius, endpoint_nasolabial_ridge_l_14.length, 32, 12)
    : buildTubeGeometry({"points": [[0.115, -0.297, 0.3786], [0.175, -0.437, 0.3598], [0.235, -0.56, 0.298]], "radius": 0.018, "closed": false});
  if (!endpoint_nasolabial_ridge_l_14) {
    mesh_nasolabial_ridge_l_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nasolabial_ridge_l_14 = new THREE.Mesh(
    mesh_nasolabial_ridge_l_14Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nasolabial_ridge_l_14.name = "Nasolabial fold (l)";
  if (endpoint_nasolabial_ridge_l_14) {
    mesh_nasolabial_ridge_l_14.position.copy(endpoint_nasolabial_ridge_l_14.midpoint);
    mesh_nasolabial_ridge_l_14.quaternion.copy(endpoint_nasolabial_ridge_l_14.quaternion);
  }
  mesh_nasolabial_ridge_l_14.castShadow = options.castShadow ?? true;
  mesh_nasolabial_ridge_l_14.receiveShadow = options.receiveShadow ?? true;
  mesh_nasolabial_ridge_l_14.userData.sculptComponent = {"id": "nasolabial-ridge-l", "name": "Nasolabial fold (l)", "level": "micro", "role": "body", "importance": 0.5, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "geometryDescriptor": {"topologyIntent": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[0.115, -0.297, 0.3786], [0.175, -0.437, 0.3598], [0.235, -0.56, 0.298]], "radius": 0.018, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "fold-seat-l", "localStart": [0.115, -0.297, 0.3786], "localEnd": [0.235, -0.56, 0.298], "contactType": "overlap", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0.3, 0, 0.95]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_nasolabial_ridge_l_14.add(mesh_nasolabial_ridge_l_14);
  meshes["nasolabial-ridge-l"] = mesh_nasolabial_ridge_l_14;
  colliders["nasolabial-ridge-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_nasolabial_ridge_l_14);

  const attachment_nasolabial_ridge_r_15 = {"parentId": "mask-shell", "parentSocket": "fold-seat-r", "localStart": [-0.115, -0.297, 0.3786], "localEnd": [-0.235, -0.56, 0.298], "contactType": "overlap", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [-0.3, 0, 0.95]};
  const endpoint_nasolabial_ridge_r_15 = makeAttachmentEndpoint(attachment_nasolabial_ridge_r_15);
  const node_nasolabial_ridge_r_15 = new THREE.Group();
  node_nasolabial_ridge_r_15.name = "Nasolabial fold (r)__pivot";
  node_nasolabial_ridge_r_15.scale.set(1, 1, 1);
  if (endpoint_nasolabial_ridge_r_15) {
    node_nasolabial_ridge_r_15.position.copy(endpoint_nasolabial_ridge_r_15.start);
    node_nasolabial_ridge_r_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_nasolabial_ridge_r_15.position.set(0.0, 0.0, 0.0);
    node_nasolabial_ridge_r_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_nasolabial_ridge_r_15.userData.sculptComponent = {"id": "nasolabial-ridge-r", "name": "Nasolabial fold (r)", "level": "micro", "role": "body", "importance": 0.5, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "geometryDescriptor": {"topologyIntent": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.115, -0.297, 0.3786], [-0.175, -0.437, 0.3598], [-0.235, -0.56, 0.298]], "radius": 0.018, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "fold-seat-r", "localStart": [-0.115, -0.297, 0.3786], "localEnd": [-0.235, -0.56, 0.298], "contactType": "overlap", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [-0.3, 0, 0.95]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_nasolabial_ridge_r_15.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_nasolabial_ridge_r_15);
  nodes["nasolabial-ridge-r"] = node_nasolabial_ridge_r_15;
  const mesh_nasolabial_ridge_r_15Geometry = endpoint_nasolabial_ridge_r_15
    ? new THREE.CylinderGeometry(endpoint_nasolabial_ridge_r_15.endRadius, endpoint_nasolabial_ridge_r_15.baseRadius, endpoint_nasolabial_ridge_r_15.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.115, -0.297, 0.3786], [-0.175, -0.437, 0.3598], [-0.235, -0.56, 0.298]], "radius": 0.018, "closed": false});
  if (!endpoint_nasolabial_ridge_r_15) {
    mesh_nasolabial_ridge_r_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_nasolabial_ridge_r_15 = new THREE.Mesh(
    mesh_nasolabial_ridge_r_15Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_nasolabial_ridge_r_15.name = "Nasolabial fold (r)";
  if (endpoint_nasolabial_ridge_r_15) {
    mesh_nasolabial_ridge_r_15.position.copy(endpoint_nasolabial_ridge_r_15.midpoint);
    mesh_nasolabial_ridge_r_15.quaternion.copy(endpoint_nasolabial_ridge_r_15.quaternion);
  }
  mesh_nasolabial_ridge_r_15.castShadow = options.castShadow ?? true;
  mesh_nasolabial_ridge_r_15.receiveShadow = options.receiveShadow ?? true;
  mesh_nasolabial_ridge_r_15.userData.sculptComponent = {"id": "nasolabial-ridge-r", "name": "Nasolabial fold (r)", "level": "micro", "role": "body", "importance": 0.5, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "geometryDescriptor": {"topologyIntent": "The fold from the ala to the mouth corner — positive relief as a thin swept ridge.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.115, -0.297, 0.3786], [-0.175, -0.437, 0.3598], [-0.235, -0.56, 0.298]], "radius": 0.018, "closed": false}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "fold-seat-r", "localStart": [-0.115, -0.297, 0.3786], "localEnd": [-0.235, -0.56, 0.298], "contactType": "overlap", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [-0.3, 0, 0.95]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_nasolabial_ridge_r_15.add(mesh_nasolabial_ridge_r_15);
  meshes["nasolabial-ridge-r"] = mesh_nasolabial_ridge_r_15;
  colliders["nasolabial-ridge-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_nasolabial_ridge_r_15);

  const attachment_horn_collar_ring_l_16 = {"parentId": "horn-l", "parentSocket": "horn-socket-l", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0.45, 0.85, 0.1]};
  const endpoint_horn_collar_ring_l_16 = makeAttachmentEndpoint(attachment_horn_collar_ring_l_16);
  const node_horn_collar_ring_l_16 = new THREE.Group();
  node_horn_collar_ring_l_16.name = "Horn base collar (l)__pivot";
  node_horn_collar_ring_l_16.scale.set(1, 1, 1);
  if (endpoint_horn_collar_ring_l_16) {
    node_horn_collar_ring_l_16.position.copy(endpoint_horn_collar_ring_l_16.start);
    node_horn_collar_ring_l_16.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_horn_collar_ring_l_16.position.set(0.0, 0.0, 0.0);
    node_horn_collar_ring_l_16.rotation.set(0.0, 0.0, 0.0);
  }
  node_horn_collar_ring_l_16.userData.sculptComponent = {"id": "horn-collar-ring-l", "name": "Horn base collar (l)", "level": "micro", "role": "body", "importance": 0.4, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "geometryDescriptor": {"topologyIntent": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[0.5431, 0.0279, 0.063], [0.5105, 0.0325, -0.0414], [0.4424, 0.0713, -0.1179], [0.3571, 0.1339, -0.1458], [0.2774, 0.2036, -0.1179], [0.2247, 0.2616, -0.0414], [0.2131, 0.2924, 0.063], [0.2457, 0.2878, 0.1674], [0.3138, 0.249, 0.2438], [0.3991, 0.1864, 0.2718], [0.4788, 0.1167, 0.2438], [0.5315, 0.0587, 0.1674]], "radius": 0.0392, "closed": true}}, "parent": "horn-l", "attachment": {"parentId": "horn-l", "parentSocket": "horn-socket-l", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_collar_ring_l_16.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["horn-l"] ?? root).add(node_horn_collar_ring_l_16);
  nodes["horn-collar-ring-l"] = node_horn_collar_ring_l_16;
  const mesh_horn_collar_ring_l_16Geometry = endpoint_horn_collar_ring_l_16
    ? new THREE.CylinderGeometry(endpoint_horn_collar_ring_l_16.endRadius, endpoint_horn_collar_ring_l_16.baseRadius, endpoint_horn_collar_ring_l_16.length, 32, 12)
    : buildTubeGeometry({"points": [[0.5431, 0.0279, 0.063], [0.5105, 0.0325, -0.0414], [0.4424, 0.0713, -0.1179], [0.3571, 0.1339, -0.1458], [0.2774, 0.2036, -0.1179], [0.2247, 0.2616, -0.0414], [0.2131, 0.2924, 0.063], [0.2457, 0.2878, 0.1674], [0.3138, 0.249, 0.2438], [0.3991, 0.1864, 0.2718], [0.4788, 0.1167, 0.2438], [0.5315, 0.0587, 0.1674]], "radius": 0.0392, "closed": true});
  if (!endpoint_horn_collar_ring_l_16) {
    mesh_horn_collar_ring_l_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_collar_ring_l_16 = new THREE.Mesh(
    mesh_horn_collar_ring_l_16Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_collar_ring_l_16.name = "Horn base collar (l)";
  if (endpoint_horn_collar_ring_l_16) {
    mesh_horn_collar_ring_l_16.position.copy(endpoint_horn_collar_ring_l_16.midpoint);
    mesh_horn_collar_ring_l_16.quaternion.copy(endpoint_horn_collar_ring_l_16.quaternion);
  }
  mesh_horn_collar_ring_l_16.castShadow = options.castShadow ?? true;
  mesh_horn_collar_ring_l_16.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_collar_ring_l_16.userData.sculptComponent = {"id": "horn-collar-ring-l", "name": "Horn base collar (l)", "level": "micro", "role": "body", "importance": 0.4, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "geometryDescriptor": {"topologyIntent": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[0.5431, 0.0279, 0.063], [0.5105, 0.0325, -0.0414], [0.4424, 0.0713, -0.1179], [0.3571, 0.1339, -0.1458], [0.2774, 0.2036, -0.1179], [0.2247, 0.2616, -0.0414], [0.2131, 0.2924, 0.063], [0.2457, 0.2878, 0.1674], [0.3138, 0.249, 0.2438], [0.3991, 0.1864, 0.2718], [0.4788, 0.1167, 0.2438], [0.5315, 0.0587, 0.1674]], "radius": 0.0392, "closed": true}}, "parent": "horn-l", "attachment": {"parentId": "horn-l", "parentSocket": "horn-socket-l", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_collar_ring_l_16.add(mesh_horn_collar_ring_l_16);
  meshes["horn-collar-ring-l"] = mesh_horn_collar_ring_l_16;
  colliders["horn-collar-ring-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_horn_collar_ring_l_16);

  const attachment_horn_collar_ring_r_17 = {"parentId": "horn-r", "parentSocket": "horn-socket-r", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [-0.45, 0.85, 0.1]};
  const endpoint_horn_collar_ring_r_17 = makeAttachmentEndpoint(attachment_horn_collar_ring_r_17);
  const node_horn_collar_ring_r_17 = new THREE.Group();
  node_horn_collar_ring_r_17.name = "Horn base collar (r)__pivot";
  node_horn_collar_ring_r_17.scale.set(1, 1, 1);
  if (endpoint_horn_collar_ring_r_17) {
    node_horn_collar_ring_r_17.position.copy(endpoint_horn_collar_ring_r_17.start);
    node_horn_collar_ring_r_17.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_horn_collar_ring_r_17.position.set(0.0, 0.0, 0.0);
    node_horn_collar_ring_r_17.rotation.set(0.0, 0.0, 0.0);
  }
  node_horn_collar_ring_r_17.userData.sculptComponent = {"id": "horn-collar-ring-r", "name": "Horn base collar (r)", "level": "micro", "role": "body", "importance": 0.4, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "geometryDescriptor": {"topologyIntent": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.2131, 0.2924, 0.063], [-0.2247, 0.2616, -0.0414], [-0.2774, 0.2036, -0.1179], [-0.3571, 0.1339, -0.1458], [-0.4424, 0.0713, -0.1179], [-0.5105, 0.0325, -0.0414], [-0.5431, 0.0279, 0.063], [-0.5315, 0.0587, 0.1674], [-0.4788, 0.1167, 0.2438], [-0.3991, 0.1864, 0.2718], [-0.3138, 0.249, 0.2438], [-0.2457, 0.2878, 0.1674]], "radius": 0.0392, "closed": true}}, "parent": "horn-r", "attachment": {"parentId": "horn-r", "parentSocket": "horn-socket-r", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [-0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_collar_ring_r_17.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["horn-r"] ?? root).add(node_horn_collar_ring_r_17);
  nodes["horn-collar-ring-r"] = node_horn_collar_ring_r_17;
  const mesh_horn_collar_ring_r_17Geometry = endpoint_horn_collar_ring_r_17
    ? new THREE.CylinderGeometry(endpoint_horn_collar_ring_r_17.endRadius, endpoint_horn_collar_ring_r_17.baseRadius, endpoint_horn_collar_ring_r_17.length, 32, 12)
    : buildTubeGeometry({"points": [[-0.2131, 0.2924, 0.063], [-0.2247, 0.2616, -0.0414], [-0.2774, 0.2036, -0.1179], [-0.3571, 0.1339, -0.1458], [-0.4424, 0.0713, -0.1179], [-0.5105, 0.0325, -0.0414], [-0.5431, 0.0279, 0.063], [-0.5315, 0.0587, 0.1674], [-0.4788, 0.1167, 0.2438], [-0.3991, 0.1864, 0.2718], [-0.3138, 0.249, 0.2438], [-0.2457, 0.2878, 0.1674]], "radius": 0.0392, "closed": true});
  if (!endpoint_horn_collar_ring_r_17) {
    mesh_horn_collar_ring_r_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_horn_collar_ring_r_17 = new THREE.Mesh(
    mesh_horn_collar_ring_r_17Geometry,
    materialMap["clay-shell"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_horn_collar_ring_r_17.name = "Horn base collar (r)";
  if (endpoint_horn_collar_ring_r_17) {
    mesh_horn_collar_ring_r_17.position.copy(endpoint_horn_collar_ring_r_17.midpoint);
    mesh_horn_collar_ring_r_17.quaternion.copy(endpoint_horn_collar_ring_r_17.quaternion);
  }
  mesh_horn_collar_ring_r_17.castShadow = options.castShadow ?? true;
  mesh_horn_collar_ring_r_17.receiveShadow = options.receiveShadow ?? true;
  mesh_horn_collar_ring_r_17.userData.sculptComponent = {"id": "horn-collar-ring-r", "name": "Horn base collar (r)", "level": "micro", "role": "body", "importance": 0.4, "confidence": 0.75, "primitive": "tube", "topologyClass": "surface-relief", "topologyRationale": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "geometryDescriptor": {"topologyIntent": "The raised ring where the horn seats into the skull — a socket seam read as a torus lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "tubePath": {"points": [[-0.2131, 0.2924, 0.063], [-0.2247, 0.2616, -0.0414], [-0.2774, 0.2036, -0.1179], [-0.3571, 0.1339, -0.1458], [-0.4424, 0.0713, -0.1179], [-0.5105, 0.0325, -0.0414], [-0.5431, 0.0279, 0.063], [-0.5315, 0.0587, 0.1674], [-0.4788, 0.1167, 0.2438], [-0.3991, 0.1864, 0.2718], [-0.3138, 0.249, 0.2438], [-0.2457, 0.2878, 0.1674]], "radius": 0.0392, "closed": true}}, "parent": "horn-r", "attachment": {"parentId": "horn-r", "parentSocket": "horn-socket-r", "localStart": [0, 0, 0], "localEnd": [0, 0, 0.02], "contactType": "overlap", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [-0.45, 0.85, 0.1]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "clay-shell", "materialLayers": ["clay-shell"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "three-quarter"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(185, 182, 178, 1.0)", "secondaryAlbedo": "rgba(168, 165, 161, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_horn_collar_ring_r_17.add(mesh_horn_collar_ring_r_17);
  meshes["horn-collar-ring-r"] = mesh_horn_collar_ring_r_17;
  colliders["horn-collar-ring-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_horn_collar_ring_r_17);

  const endpoint_upper_fang_l_18 = makeAttachmentEndpoint(null);
  const node_upper_fang_l_18 = new THREE.Group();
  node_upper_fang_l_18.name = "upper fang l__pivot";
  node_upper_fang_l_18.scale.set(1, 1, 1);
  if (endpoint_upper_fang_l_18) {
    node_upper_fang_l_18.position.copy(endpoint_upper_fang_l_18.start);
    node_upper_fang_l_18.rotation.set(3.141592653589793, 0.0, 0.1);
  } else {
    node_upper_fang_l_18.position.set(0.1662, -0.615, 0.3167);
    node_upper_fang_l_18.rotation.set(3.141592653589793, 0.0, 0.1);
  }
  node_upper_fang_l_18.userData.sculptComponent = {"id": "upper-fang-l", "name": "upper fang l", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.0775], [0.03, -0.06665], [0.020999999999999998, -0.012400000000000008], [0.008400000000000001, 0.0465], [0.0008, 0.0775]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-underside-l", "localStart": [0, 0.05, 0], "localEnd": [0, -0.08, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, -1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1662, -0.615, 0.3167], "rotation": [3.141592653589793, 0, 0.1], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_upper_fang_l_18.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_upper_fang_l_18);
  nodes["upper-fang-l"] = node_upper_fang_l_18;
  const mesh_upper_fang_l_18Geometry = endpoint_upper_fang_l_18
    ? new THREE.CylinderGeometry(endpoint_upper_fang_l_18.endRadius, endpoint_upper_fang_l_18.baseRadius, endpoint_upper_fang_l_18.length, 32, 12)
    : buildLatheGeometry({"points": [[0.0008, -0.0775], [0.03, -0.06665], [0.020999999999999998, -0.012400000000000008], [0.008400000000000001, 0.0465], [0.0008, 0.0775]], "segments": 14});
  if (!endpoint_upper_fang_l_18) {
    mesh_upper_fang_l_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_fang_l_18 = new THREE.Mesh(
    mesh_upper_fang_l_18Geometry,
    materialMap["dentition"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_fang_l_18.name = "upper fang l";
  if (endpoint_upper_fang_l_18) {
    mesh_upper_fang_l_18.position.copy(endpoint_upper_fang_l_18.midpoint);
    mesh_upper_fang_l_18.quaternion.copy(endpoint_upper_fang_l_18.quaternion);
  }
  mesh_upper_fang_l_18.castShadow = options.castShadow ?? true;
  mesh_upper_fang_l_18.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_fang_l_18.userData.sculptComponent = {"id": "upper-fang-l", "name": "upper fang l", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.0775], [0.03, -0.06665], [0.020999999999999998, -0.012400000000000008], [0.008400000000000001, 0.0465], [0.0008, 0.0775]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-underside-l", "localStart": [0, 0.05, 0], "localEnd": [0, -0.08, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, -1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.1662, -0.615, 0.3167], "rotation": [3.141592653589793, 0, 0.1], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_upper_fang_l_18.add(mesh_upper_fang_l_18);
  meshes["upper-fang-l"] = mesh_upper_fang_l_18;
  colliders["upper-fang-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_upper_fang_l_18);

  const endpoint_upper_fang_r_19 = makeAttachmentEndpoint(null);
  const node_upper_fang_r_19 = new THREE.Group();
  node_upper_fang_r_19.name = "upper fang r__pivot";
  node_upper_fang_r_19.scale.set(1, 1, 1);
  if (endpoint_upper_fang_r_19) {
    node_upper_fang_r_19.position.copy(endpoint_upper_fang_r_19.start);
    node_upper_fang_r_19.rotation.set(3.141592653589793, 0.0, -0.1);
  } else {
    node_upper_fang_r_19.position.set(-0.1662, -0.615, 0.3167);
    node_upper_fang_r_19.rotation.set(3.141592653589793, 0.0, -0.1);
  }
  node_upper_fang_r_19.userData.sculptComponent = {"id": "upper-fang-r", "name": "upper fang r", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.0775], [0.03, -0.06665], [0.020999999999999998, -0.012400000000000008], [0.008400000000000001, 0.0465], [0.0008, 0.0775]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-underside-r", "localStart": [0, 0.05, 0], "localEnd": [0, -0.08, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, -1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1662, -0.615, 0.3167], "rotation": [3.141592653589793, 0, -0.1], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_upper_fang_r_19.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_upper_fang_r_19);
  nodes["upper-fang-r"] = node_upper_fang_r_19;
  const mesh_upper_fang_r_19Geometry = endpoint_upper_fang_r_19
    ? new THREE.CylinderGeometry(endpoint_upper_fang_r_19.endRadius, endpoint_upper_fang_r_19.baseRadius, endpoint_upper_fang_r_19.length, 32, 12)
    : buildLatheGeometry({"points": [[0.0008, -0.0775], [0.03, -0.06665], [0.020999999999999998, -0.012400000000000008], [0.008400000000000001, 0.0465], [0.0008, 0.0775]], "segments": 14});
  if (!endpoint_upper_fang_r_19) {
    mesh_upper_fang_r_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_upper_fang_r_19 = new THREE.Mesh(
    mesh_upper_fang_r_19Geometry,
    materialMap["dentition"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_upper_fang_r_19.name = "upper fang r";
  if (endpoint_upper_fang_r_19) {
    mesh_upper_fang_r_19.position.copy(endpoint_upper_fang_r_19.midpoint);
    mesh_upper_fang_r_19.quaternion.copy(endpoint_upper_fang_r_19.quaternion);
  }
  mesh_upper_fang_r_19.castShadow = options.castShadow ?? true;
  mesh_upper_fang_r_19.receiveShadow = options.receiveShadow ?? true;
  mesh_upper_fang_r_19.userData.sculptComponent = {"id": "upper-fang-r", "name": "upper fang r", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture downward from the upper lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.0775], [0.03, -0.06665], [0.020999999999999998, -0.012400000000000008], [0.008400000000000001, 0.0465], [0.0008, 0.0775]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-underside-r", "localStart": [0, 0.05, 0], "localEnd": [0, -0.08, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, -1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.1662, -0.615, 0.3167], "rotation": [3.141592653589793, 0, -0.1], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_upper_fang_r_19.add(mesh_upper_fang_r_19);
  meshes["upper-fang-r"] = mesh_upper_fang_r_19;
  colliders["upper-fang-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_upper_fang_r_19);

  const endpoint_lower_fang_l_20 = makeAttachmentEndpoint(null);
  const node_lower_fang_l_20 = new THREE.Group();
  node_lower_fang_l_20.name = "lower fang l__pivot";
  node_lower_fang_l_20.scale.set(1, 1, 1);
  if (endpoint_lower_fang_l_20) {
    node_lower_fang_l_20.position.copy(endpoint_lower_fang_l_20.start);
    node_lower_fang_l_20.rotation.set(0.0, 0.0, -0.08);
  } else {
    node_lower_fang_l_20.position.set(0.2144, -0.65, 0.268);
    node_lower_fang_l_20.rotation.set(0.0, 0.0, -0.08);
  }
  node_lower_fang_l_20.userData.sculptComponent = {"id": "lower-fang-l", "name": "lower fang l", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.05], [0.024, -0.043000000000000003], [0.0168, -0.008], [0.006720000000000001, 0.03], [0.0008, 0.05]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "lower-lip-crest-l", "localStart": [0, -0.05, 0], "localEnd": [0, 0.05, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.2144, -0.65, 0.268], "rotation": [0, 0, -0.08], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_lower_fang_l_20.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_lower_fang_l_20);
  nodes["lower-fang-l"] = node_lower_fang_l_20;
  const mesh_lower_fang_l_20Geometry = endpoint_lower_fang_l_20
    ? new THREE.CylinderGeometry(endpoint_lower_fang_l_20.endRadius, endpoint_lower_fang_l_20.baseRadius, endpoint_lower_fang_l_20.length, 32, 12)
    : buildLatheGeometry({"points": [[0.0008, -0.05], [0.024, -0.043000000000000003], [0.0168, -0.008], [0.006720000000000001, 0.03], [0.0008, 0.05]], "segments": 14});
  if (!endpoint_lower_fang_l_20) {
    mesh_lower_fang_l_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lower_fang_l_20 = new THREE.Mesh(
    mesh_lower_fang_l_20Geometry,
    materialMap["dentition"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lower_fang_l_20.name = "lower fang l";
  if (endpoint_lower_fang_l_20) {
    mesh_lower_fang_l_20.position.copy(endpoint_lower_fang_l_20.midpoint);
    mesh_lower_fang_l_20.quaternion.copy(endpoint_lower_fang_l_20.quaternion);
  }
  mesh_lower_fang_l_20.castShadow = options.castShadow ?? true;
  mesh_lower_fang_l_20.receiveShadow = options.receiveShadow ?? true;
  mesh_lower_fang_l_20.userData.sculptComponent = {"id": "lower-fang-l", "name": "lower fang l", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.05], [0.024, -0.043000000000000003], [0.0168, -0.008], [0.006720000000000001, 0.03], [0.0008, 0.05]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "lower-lip-crest-l", "localStart": [0, -0.05, 0], "localEnd": [0, 0.05, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0.2144, -0.65, 0.268], "rotation": [0, 0, -0.08], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_lower_fang_l_20.add(mesh_lower_fang_l_20);
  meshes["lower-fang-l"] = mesh_lower_fang_l_20;
  colliders["lower-fang-l"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_lower_fang_l_20);

  const endpoint_lower_fang_r_21 = makeAttachmentEndpoint(null);
  const node_lower_fang_r_21 = new THREE.Group();
  node_lower_fang_r_21.name = "lower fang r__pivot";
  node_lower_fang_r_21.scale.set(1, 1, 1);
  if (endpoint_lower_fang_r_21) {
    node_lower_fang_r_21.position.copy(endpoint_lower_fang_r_21.start);
    node_lower_fang_r_21.rotation.set(0.0, 0.0, 0.08);
  } else {
    node_lower_fang_r_21.position.set(-0.2144, -0.65, 0.268);
    node_lower_fang_r_21.rotation.set(0.0, 0.0, 0.08);
  }
  node_lower_fang_r_21.userData.sculptComponent = {"id": "lower-fang-r", "name": "lower fang r", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.05], [0.024, -0.043000000000000003], [0.0168, -0.008], [0.006720000000000001, 0.03], [0.0008, 0.05]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "lower-lip-crest-r", "localStart": [0, -0.05, 0], "localEnd": [0, 0.05, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2144, -0.65, 0.268], "rotation": [0, 0, 0.08], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_lower_fang_r_21.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_lower_fang_r_21);
  nodes["lower-fang-r"] = node_lower_fang_r_21;
  const mesh_lower_fang_r_21Geometry = endpoint_lower_fang_r_21
    ? new THREE.CylinderGeometry(endpoint_lower_fang_r_21.endRadius, endpoint_lower_fang_r_21.baseRadius, endpoint_lower_fang_r_21.length, 32, 12)
    : buildLatheGeometry({"points": [[0.0008, -0.05], [0.024, -0.043000000000000003], [0.0168, -0.008], [0.006720000000000001, 0.03], [0.0008, 0.05]], "segments": 14});
  if (!endpoint_lower_fang_r_21) {
    mesh_lower_fang_r_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lower_fang_r_21 = new THREE.Mesh(
    mesh_lower_fang_r_21Geometry,
    materialMap["dentition"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lower_fang_r_21.name = "lower fang r";
  if (endpoint_lower_fang_r_21) {
    mesh_lower_fang_r_21.position.copy(endpoint_lower_fang_r_21.midpoint);
    mesh_lower_fang_r_21.quaternion.copy(endpoint_lower_fang_r_21.quaternion);
  }
  mesh_lower_fang_r_21.castShadow = options.castShadow ?? true;
  mesh_lower_fang_r_21.receiveShadow = options.receiveShadow ?? true;
  mesh_lower_fang_r_21.userData.sculptComponent = {"id": "lower-fang-r", "name": "lower fang r", "level": "micro", "role": "body", "importance": 0.85, "confidence": 0.9, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "geometryDescriptor": {"topologyIntent": "A fang: cone tapering to a point, projecting into the mouth aperture upward from the lower lip.", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0008, -0.05], [0.024, -0.043000000000000003], [0.0168, -0.008], [0.006720000000000001, 0.03], [0.0008, 0.05]], "segments": 14}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "lower-lip-crest-r", "localStart": [0, -0.05, 0], "localEnd": [0, 0.05, 0], "contactType": "butt", "embedDepth": 0.03, "overlap": 0.03, "gapTolerance": 0.01, "contactNormal": [0, 1, 0]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [-0.2144, -0.65, 0.268], "rotation": [0, 0, 0.08], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_lower_fang_r_21.add(mesh_lower_fang_r_21);
  meshes["lower-fang-r"] = mesh_lower_fang_r_21;
  colliders["lower-fang-r"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_lower_fang_r_21);

  const endpoint_incisor_row_22 = makeAttachmentEndpoint(null);
  const node_incisor_row_22 = new THREE.Group();
  node_incisor_row_22.name = "Incisor row__pivot";
  node_incisor_row_22.scale.set(1, 1, 1);
  if (endpoint_incisor_row_22) {
    node_incisor_row_22.position.copy(endpoint_incisor_row_22.start);
    node_incisor_row_22.rotation.set(-0.4, 0.0, 0.0);
  } else {
    node_incisor_row_22.position.set(0.0, -0.593, 0.3275);
    node_incisor_row_22.rotation.set(-0.4, 0.0, 0.0);
  }
  node_incisor_row_22.userData.sculptComponent = {"id": "incisor-row", "name": "Incisor row", "level": "micro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Six rectangular incisors from a common gum bar — one comb profile extruded thin. Declared as the repetition system 'incisor-row' (component-expanded).", "geometryDescriptor": {"topologyIntent": "Six rectangular incisors from a common gum bar — one comb profile extruded thin. Declared as the repetition system 'incisor-row' (component-expanded).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.14049999999999999, 0.028], [0.14049999999999999, 0.028], [0.1405, 0.0], [0.1351, -0.055], [0.1099, -0.055], [0.1045, 0.0], [0.0915, 0.0], [0.0861, -0.055], [0.0609, -0.055], [0.0555, 0.0], [0.0425, 0.0], [0.0371, -0.055], [0.0119, -0.055], [0.0065, 0.0], [-0.0065, 0.0], [-0.0119, -0.055], [-0.0371, -0.055], [-0.0425, 0.0], [-0.0555, 0.0], [-0.0609, -0.055], [-0.0861, -0.055], [-0.0915, 0.0], [-0.1045, 0.0], [-0.1099, -0.055], [-0.1351, -0.055], [-0.1405, 0.0]], "depth": 0.05}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-underside-center", "localStart": [-0.10725, 0, 0], "localEnd": [0.10725, 0, 0], "contactType": "flush", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0, -0.4, 0.9]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, -0.593, 0.3275], "rotation": [-0.4, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_incisor_row_22.userData.actionProfile = {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}};
  (nodes["mask-shell"] ?? root).add(node_incisor_row_22);
  nodes["incisor-row"] = node_incisor_row_22;
  const mesh_incisor_row_22Geometry = endpoint_incisor_row_22
    ? new THREE.CylinderGeometry(endpoint_incisor_row_22.endRadius, endpoint_incisor_row_22.baseRadius, endpoint_incisor_row_22.length, 32, 12)
    : buildExtrudeGeometry({"points": [[-0.14049999999999999, 0.028], [0.14049999999999999, 0.028], [0.1405, 0.0], [0.1351, -0.055], [0.1099, -0.055], [0.1045, 0.0], [0.0915, 0.0], [0.0861, -0.055], [0.0609, -0.055], [0.0555, 0.0], [0.0425, 0.0], [0.0371, -0.055], [0.0119, -0.055], [0.0065, 0.0], [-0.0065, 0.0], [-0.0119, -0.055], [-0.0371, -0.055], [-0.0425, 0.0], [-0.0555, 0.0], [-0.0609, -0.055], [-0.0861, -0.055], [-0.0915, 0.0], [-0.1045, 0.0], [-0.1099, -0.055], [-0.1351, -0.055], [-0.1405, 0.0]], "depth": 0.05});
  if (!endpoint_incisor_row_22) {
    mesh_incisor_row_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_incisor_row_22 = new THREE.Mesh(
    mesh_incisor_row_22Geometry,
    materialMap["dentition"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_incisor_row_22.name = "Incisor row";
  if (endpoint_incisor_row_22) {
    mesh_incisor_row_22.position.copy(endpoint_incisor_row_22.midpoint);
    mesh_incisor_row_22.quaternion.copy(endpoint_incisor_row_22.quaternion);
  }
  mesh_incisor_row_22.castShadow = options.castShadow ?? true;
  mesh_incisor_row_22.receiveShadow = options.receiveShadow ?? true;
  mesh_incisor_row_22.userData.sculptComponent = {"id": "incisor-row", "name": "Incisor row", "level": "micro", "role": "body", "importance": 0.8, "confidence": 0.85, "primitive": "extrude", "topologyClass": "assembled-solid", "topologyRationale": "Six rectangular incisors from a common gum bar — one comb profile extruded thin. Declared as the repetition system 'incisor-row' (component-expanded).", "geometryDescriptor": {"topologyIntent": "Six rectangular incisors from a common gum bar — one comb profile extruded thin. Declared as the repetition system 'incisor-row' (component-expanded).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "profile2D": {"points": [[-0.14049999999999999, 0.028], [0.14049999999999999, 0.028], [0.1405, 0.0], [0.1351, -0.055], [0.1099, -0.055], [0.1045, 0.0], [0.0915, 0.0], [0.0861, -0.055], [0.0609, -0.055], [0.0555, 0.0], [0.0425, 0.0], [0.0371, -0.055], [0.0119, -0.055], [0.0065, 0.0], [-0.0065, 0.0], [-0.0119, -0.055], [-0.0371, -0.055], [-0.0425, 0.0], [-0.0555, 0.0], [-0.0609, -0.055], [-0.0861, -0.055], [-0.0915, 0.0], [-0.1045, 0.0], [-0.1099, -0.055], [-0.1351, -0.055], [-0.1405, 0.0]], "depth": 0.05}}, "parent": "mask-shell", "attachment": {"parentId": "mask-shell", "parentSocket": "upper-lip-underside-center", "localStart": [-0.10725, 0, 0], "localEnd": [0.10725, 0, 0], "contactType": "flush", "embedDepth": 0.02, "overlap": 0.02, "gapTolerance": 0.01, "contactNormal": [0, -0.4, 0.9]}, "dimensions": {"width": 1, "height": 1, "depth": 1, "units": "relative", "confidence": 0.85}, "transform": {"position": [0, -0.593, 0.3275], "rotation": [-0.4, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "static-part", "pivot": {"mode": "custom", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.8}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": true, "visibility": true, "materialState": true}, "sockets": [], "constraints": [], "collider": {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"}, "destruction": {"breakable": false, "fractureGroup": "mask", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "clay-shell"}}, "material": "dentition", "materialLayers": ["dentition"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.12, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "cavity", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["front", "below"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(203, 200, 195, 1.0)", "secondaryAlbedo": "rgba(185, 182, 178, 1.0)", "materialClass": "ceramic", "materialClassConfidence": 0.5, "notes": "Reference is an achromatic clay preview; class 'ceramic' is the nearest match for a matte rigid mask shell and is declared, not extracted."}};
  node_incisor_row_22.add(mesh_incisor_row_22);
  meshes["incisor-row"] = mesh_incisor_row_22;
  colliders["incisor-row"] = {"type": "box", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "box proxy is adequate for a static prop part"};
  destructionGroups["mask"] ??= [];
  destructionGroups["mask"].push(node_incisor_row_22);

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createHannyaMaskLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Hannya Mask look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "directional", "direction": [-0.35, 0.75, 0.55], "color": "#FFFFFF", "intensity": 1.0, "evidence": "soft top-left key: brow and cranium crests brightest, shadows fall under brow and lower lip in front.png"}, {"id": "fill", "type": "ambient", "color": "#EAEAEA", "intensity": 0.55, "evidence": "shadows never go black — a high-value neutral fill consistent with a seamless grey studio"}, {"id": "rim", "type": "directional", "direction": [0.2, 0.3, -0.9], "color": "#F5F5F5", "intensity": 0.25, "evidence": "faint separation light on the posterior rim and horn backs in the rear/profile views"}, {"id": "render-intent", "type": "intent", "exposure": 1.0, "toneMapping": "ACES filmic at exposure 1.0 (neutral studio; no HDR excursions in a matte clay scene)", "shadows": "soft contact shadow under the jaw and horn roots; ambient occlusion in cavities only — no ground plane in the reference (mask floats on seamless grey)"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createHannyaMaskEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameHannyaMaskCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createHannyaMaskPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureHannyaMaskRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createHannyaMaskInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
