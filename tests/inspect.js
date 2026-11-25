import fs from 'fs';
import { readEvmap, NODE } from '../src/evmap/format.js';
for (const f of process.argv.slice(2)) {
  const buf = fs.readFileSync(f); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  const m = readEvmap(ab);
  console.log('\n=====', f.split(/[\/]/).pop(), `read ${m.bytesRead}/${m.bytesTotal}`, 'features', m.features, 'ext', m.featuresExt);
  console.log('meshes', m.meshes.length, 'textures', m.textures.length, 'materials', (m.materials||m.materialsEx).length, m.materialsEx ? '(Ex)' : '');
  const feats = {}; let nodes = 0;
  (function walk(n, d) { nodes++; feats[n.features] = (feats[n.features] || 0) + 1; n.children.forEach(c => walk(c, d + 1)); })(m.rootObject, 0);
  console.log('nodes', nodes, 'node features histogram', feats, 'root', JSON.stringify(m.rootObject.transform));
  console.log('weaponSpawns', (m.weaponSpawns||m.weaponSpawnsEx).length, 'playerSpawns', m.playerSpawns.length, 'sample', JSON.stringify(m.playerSpawns.slice(0,3)));
  console.log('lights', JSON.stringify(m.directionalLights));
  console.log('shadow', JSON.stringify(m.shadowSettings), 'sky', JSON.stringify(m.gradientSkybox || m.skybox));
  console.log('fog', JSON.stringify(m.fogColor), m.fogDensity, 'legacy', JSON.stringify(m.legacyAmbient), 'hemi', JSON.stringify([m.hemisphereSkyColor, m.hemisphereGroundColor, m.hemisphereIntensity]));
  console.log('camPaths', m.cameraPaths?.length, JSON.stringify(m.cameraPaths?.[0]), 'nav', m.aiNavNodes?.length, 'tele', JSON.stringify(m.teleporters?.slice(0,2)), 'br', JSON.stringify(m.battleRoyaleCircle), 'far', m.cameraFarPlane);
  const mat0 = (m.materials||m.materialsEx.map(x=>x.material))[0]; console.log('material0', JSON.stringify(mat0));
  console.log('mesh0 features', m.meshes[0].features, 'verts', m.meshes[0].vertexBuffer.length/3);
  // winding vs stored normals, in FILE coordinates
  let agree = 0, disagree = 0;
  for (const mesh of m.meshes) {
    if (!mesh.normalBuffer) continue;
    const v = mesh.vertexBuffer, nb = mesh.normalBuffer;
    for (const s of mesh.submeshes) for (let i = 0; i + 2 < s.indexBuffer.length; i += 3) {
      const [a, b, c] = [s.indexBuffer[i], s.indexBuffer[i+1], s.indexBuffer[i+2]];
      const e1 = [v[b*3]-v[a*3], v[b*3+1]-v[a*3+1], v[b*3+2]-v[a*3+2]], e2 = [v[c*3]-v[a*3], v[c*3+1]-v[a*3+1], v[c*3+2]-v[a*3+2]];
      const cr = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
      const n = [nb[a*3]+nb[b*3]+nb[c*3], nb[a*3+1]+nb[b*3+1]+nb[c*3+1], nb[a*3+2]+nb[b*3+2]+nb[c*3+2]];
      const d = cr[0]*n[0]+cr[1]*n[1]+cr[2]*n[2];
      if (Math.abs(d) < 1e-9) continue; d > 0 ? agree++ : disagree++;
    }
  }
  console.log('winding: cross(b-a,c-a) along normal', agree, 'against', disagree);
}
