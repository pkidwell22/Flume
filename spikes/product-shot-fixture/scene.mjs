// Original, fixed synthetic mug fixture. Not a reusable renderer or a photograph.
// World units, geometry, light and target never change; only camera distance does.
export const WIDTH = 960;
export const HEIGHT = 540;
export const RECIPE = Object.freeze({
  id: 'owned-red-mug-v1', width: WIDTH, height: HEIGHT, supersampling: 2,
  priorFrames: 24, fps: 12, endCameraStep: 47,
  camera: 'target [0.25,0.88,0]; offset [2.7,2.02,7.2] * (1 - step*0.003); vertical FOV 35deg',
  scene: 'fixed hollow tapered cylinder; right-side toroidal handle; matte diffuse red; neutral tabletop/back wall',
  light: 'fixed normalized [-3,5,4]; ambient 0.38 + Lambert 0.62; analytic soft contact shadow',
  provenance: 'Original mathematical geometry authored for this fixture. No imported assets, logos, fonts, photographs or generation services.',
});
const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const unit = a => a.map(v => v / Math.hypot(...a));
const light = unit([-3, 5, 4]);

// One closed lathed cup profile, including its inner wall and recessed floor.
const profile = [[0,0.05],[0.70,0.05],[0.77,0.10],[0.82,0.20],
  [0.88,1.68],[0.87,1.74],[0.81,1.77],[0.75,1.73],
  [0.70,0.27],[0.65,0.20],[0,0.20]];
const triangles = [];
function quad(a, b, c, d, color, inward = false) {
  for (const vertices of [[a,b,c], [a,c,d]]) {
    let normal = unit(cross(sub(vertices[1], vertices[0]), sub(vertices[2], vertices[0])));
    if (!normal.every(Number.isFinite)) continue;
    if (inward) normal = normal.map(v => -v);
    const shade = 0.38 + 0.62 * Math.max(0, dot(normal, light));
    triangles.push({ vertices, color: color.map(v => Math.round(v * shade)) });
  }
}
for (let j = 0; j < profile.length - 1; j++) {
  for (let i = 0; i < 96; i++) {
    const a = i * 2 * Math.PI / 96, b = (i+1) * 2 * Math.PI / 96;
    const point = ([r,y], t) => [r*Math.cos(t), y, r*Math.sin(t)];
    quad(point(profile[j], a), point(profile[j+1], a),
      point(profile[j+1], b), point(profile[j], b), j >= 7 ? [174,40,34] : [202,47,39]);
  }
}
// Full elliptical toroidal handle intersects the cup on the left; hole on right.
for (let i = 0; i < 96; i++) {
  for (let j = 0; j < 16; j++) {
    const point = (u, v) => {
      const a = u * 2 * Math.PI / 96, b = v * 2 * Math.PI / 16;
      return [0.85 + (0.58 + 0.13*Math.cos(b))*Math.cos(a),
        0.96 + (0.59 + 0.13*Math.cos(b))*Math.sin(a), 0.13*Math.sin(b)];
    };
    quad(point(i,j), point(i+1,j), point(i+1,j+1), point(i,j+1), [202,47,39]);
  }
}

export function render(step) {
  if (!Number.isInteger(step) || step < 0 || step > 47) throw new Error('FIXTURE_CAMERA_ONLY');
  const w = WIDTH*2, h = HEIGHT*2;
  const scale = 1 - step*0.003;
  const target = [0.25,0.88,0];
  const eye = [2.7,2.02,7.2].map((v,i) => target[i] + v*scale);
  const forward = unit(sub(target, eye)), right = unit(cross(forward, [0,1,0]));
  const up = cross(right, forward);
  const focal = h / (2*Math.tan(35*Math.PI/360));
  const rgb = Buffer.alloc(w*h*3), depth = new Float64Array(w*h).fill(Infinity);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x+0.5-w/2)/focal, dy = (h/2-y-0.5)/focal;
      const ray = forward.map((v,i) => v + right[i]*dx + up[i]*dy);
      const t = -eye[1] / ray[1];
      const px = eye[0]+ray[0]*t, pz = eye[2]+ray[2]*t;
      const floor = t > 0 && pz > -4;
      const shadow = floor ? 0.24*Math.exp(-1.9*((px-0.3)**2/1.2 + (pz+0.25)**2/0.52)) : 0;
      const color = floor ? [215,210,202] : [229,225,218];
      const p = (y*w+x)*3;
      for (let c = 0; c < 3; c++) rgb[p+c] = Math.round(color[c]*(1-shadow));
    }
  }
  const project = point => {
    const v = sub(point, eye), z = dot(v, forward);
    return [w/2 + focal*dot(v,right)/z, h/2 - focal*dot(v,up)/z, z];
  };
  const edge = (a,b,x,y) => (b[0]-a[0])*(y-a[1]) - (b[1]-a[1])*(x-a[0]);
  for (const triangle of triangles) {
    const [a,b,c] = triangle.vertices.map(project);
    const area = edge(a,b,c[0],c[1]);
    if (Math.abs(area) < 1e-9) continue;
    const x0 = Math.max(0, Math.floor(Math.min(a[0],b[0],c[0])));
    const x1 = Math.min(w-1, Math.ceil(Math.max(a[0],b[0],c[0])));
    const y0 = Math.max(0, Math.floor(Math.min(a[1],b[1],c[1])));
    const y1 = Math.min(h-1, Math.ceil(Math.max(a[1],b[1],c[1])));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const wa = edge(b,c,x+0.5,y+0.5)/area;
        const wb = edge(c,a,x+0.5,y+0.5)/area, wc = 1-wa-wb;
        if (wa < 0 || wb < 0 || wc < 0) continue;
        const z = 1/(wa/a[2] + wb/b[2] + wc/c[2]), p = y*w+x;
        if (z >= depth[p]) continue;
        depth[p] = z;
        for (let k = 0; k < 3; k++) rgb[p*3+k] = triangle.color[k];
      }
    }
  }
  const result = Buffer.alloc(WIDTH*HEIGHT*3);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const p = (y*2*w+x*2)*3, q = (y*WIDTH+x)*3;
      for (let c = 0; c < 3; c++) result[q+c] = Math.round((rgb[p+c]+rgb[p+3+c]+rgb[p+w*3+c]+rgb[p+w*3+3+c])/4);
    }
  }
  return result;
}
