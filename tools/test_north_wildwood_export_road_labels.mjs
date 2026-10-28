import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('../assets/export-road-labels.js', import.meta.url), 'utf8');
function harness(overrides = {}) {
  const context = vm.createContext({ window: {}, AbortController, URL, setTimeout, clearTimeout,
    document: { baseURI: 'https://example.test/shorelysafe/floodmapper/north-wildwood/' }, ...overrides });
  vm.runInContext(source, context);
  return { context, api: context.window.NORTH_WILDWOOD_EXPORT_ROADS };
}
const { api } = harness();
const { buildPaths, labelName, layout, corners, overlaps, visibleRuns } = api.geometry;
const feature = (name, coordinates) => ({ type: 'Feature', properties: { name }, geometry: { type: 'LineString', coordinates } });
const collection = features => ({ type: 'FeatureCollection', features });
const plain = value => JSON.parse(JSON.stringify(value));
const project = ([x,y]) => ({ x,y });
const measure = (text, size) => text.length * size * 0.52;

// Preserve authoritative spellings and E/W distinctions while shortening only
// standard compass/suffix words. Highway-ramp database identifiers add clutter.
assert.equal(labelName('  East 26th Avenue '), 'E 26th Ave');
assert.equal(labelName('West Spruce Avenue'), 'W Spruce Ave');
assert.equal(labelName('Olde New Jersey Avenue'), 'Olde New Jersey Ave');
assert.equal(labelName('FR RT 147 EB to ANGLESEA DR'), '');
assert.equal(labelName(null), '');
assert.throws(() => buildPaths({ features: [] }), /invalid/);
assert.throws(() => buildPaths(collection([feature('Invalid', [[0,0],[1,NaN]])])), /unavailable/);

const split = collection([
  feature('Central Avenue', [[-74.80,39.00],[-74.80,39.01]]),
  feature('Central Avenue', [[-74.80,39.02],[-74.80,39.01]]),
  feature('Central Avenue', [[-74.80,39.01],[-74.80,39.00]]),
  feature('Central Avenue', [[-74.81,39.00],[-74.81,39.01]]),
  feature('East 1st Avenue', [[-74.80,39.00],[-74.79,39.00]])
]);
const before = JSON.stringify(split);
const merged = buildPaths(split);
assert.equal(JSON.stringify(split), before, 'Joining must not mutate bundled geometry');
assert.equal(merged.filter(path => path.name === 'Central Avenue').length, 2, 'Connect reversed segments, dedupe reversals, preserve disjoint carriageway');
assert.ok(merged.some(path => path.name === 'Central Avenue' && path.coordinates.length === 3));
assert.equal(merged.filter(path => path.name === 'East 1st Avenue').length, 1, 'Never join differently named roads');
const branch = buildPaths(collection([
  feature('Fork Avenue', [[0,0],[1,0]]), feature('Fork Avenue', [[1,0],[2,0]]), feature('Fork Avenue', [[1,0],[1,1]])
]));
assert.equal(branch.length, 3, 'A branch cannot become an arbitrary across-junction label path');
const loop = buildPaths(collection([feature('Loop Court', [[0,0],[1,0],[1,1],[0,1],[0,0]])]));
assert.equal(loop.length, 1);
assert.equal(loop[0].coordinates.length, 5);

const clipped = visibleRuns([{x:-20,y:50},{x:50,y:50},{x:150,y:50}],100,100);
assert.equal(clipped.length, 1);
assert.deepEqual(plain(clipped[0]), [{x:0,y:50},{x:50,y:50},{x:100,y:50}]);
assert.equal(visibleRuns([{x:-10,y:0},{x:-10,y:100}],100,100).length,0);
assert.equal(overlaps(corners(20,20,20,10,Math.PI/4), corners(20,20,10,10,0)), true);
assert.equal(overlaps(corners(20,20,20,10,Math.PI/4), corners(100,100,10,10,0)), false);

const paths = [
  { name:'Central Avenue',text:'Central Ave',coordinates:[[20,100],[480,100]] },
  { name:'East 3rd Avenue',text:'E 3rd Ave',coordinates:[[250,20],[250,280]] },
  { name:'Short Court',text:'Short Ct',coordinates:[[10,10],[30,10]] },
  { name:'Crooked Avenue',text:'Crooked Ave',coordinates:[[10,200],[60,200],[60,250],[110,250]] },
  { name:'Offscreen Avenue',text:'Offscreen Ave',coordinates:[[-200,-100],[-100,-100]] }
];
const placed = layout(paths,project,{x:500,y:300},{unit:1},measure);
assert.ok(placed.some(label => label.name === 'Central Avenue'));
assert.ok(placed.some(label => label.name === 'East 3rd Avenue'));
assert.ok(!placed.some(label => /Short|Offscreen|Crooked/.test(label.name)), 'Do not force long names onto short, bent or invisible roads');
for (const label of placed) {
  assert.ok(Math.abs(label.angle) <= Math.PI/2, 'Text must remain upright');
  assert.ok(label.box.every(point => point.x >= 0 && point.y >= 0 && point.x <= 500 && point.y <= 300));
}
for (let a=0;a<placed.length;a++) for (let b=a+1;b<placed.length;b++) assert.equal(overlaps(placed[a].box,placed[b].box),false);
assert.deepEqual(plain(layout(paths,project,{x:500,y:300},{unit:1},measure)),plain(placed),'Frozen map labels are deterministic across animated frames');
const scaled = layout(paths.map(path=>({...path,coordinates:path.coordinates.map(([x,y])=>[x*2,y*2])})),project,{x:1000,y:600},{unit:2},measure);
assert.equal(scaled.length,placed.length);
scaled.forEach((label,index)=>{
  assert.equal(label.name,placed[index].name);assert.equal(label.x,placed[index].x*2);assert.equal(label.y,placed[index].y*2);
  assert.equal(label.fontSize,placed[index].fontSize*2);assert.equal(label.halo,placed[index].halo*2);
});

// Exercise the real 603 authoritative features at the actual eight fixed
// output dimensions, allowing footer space before fitting town geometry.
const real = JSON.parse(fs.readFileSync(new URL('../assets/roads/north-wildwood-road-centerlines.geojson',import.meta.url)));
const realBefore = JSON.stringify(real), realPaths = buildPaths(real);
const realCoordinates = realPaths.flatMap(path=>path.coordinates);
const mercator = ([lng,lat])=>({x:lng,y:-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))*180/Math.PI});
const worldPoints = realCoordinates.map(mercator);
const minX=Math.min(...worldPoints.map(p=>p.x)),maxX=Math.max(...worldPoints.map(p=>p.x));
const minY=Math.min(...worldPoints.map(p=>p.y)),maxY=Math.max(...worldPoints.map(p=>p.y));
const counts=[];
for (const [width,height] of [[1920,1080],[1080,1350],[1080,1920],[1200,1200],[3840,2160],[2160,2700],[2160,3840],[2160,2160]]) {
  const unit=Math.min(width,height)/1080,mapHeight=height-Math.min(height*.4,(width<height*1.1?270:178)*Math.min(width/1200,height/900));
  const scale=Math.min(width/(maxX-minX),mapHeight/(maxY-minY))*.92;
  const projection=coordinate=>{const p=mercator(coordinate);return{x:(p.x-(minX+maxX)/2)*scale+width/2,y:(p.y-(minY+maxY)/2)*scale+mapHeight/2};};
  const labels=layout(realPaths,projection,{x:width,y:mapHeight},{unit},measure);
  assert.ok(labels.length>=12,`Town overview needs useful street coverage at ${width}×${height}: ${labels.length}`);
  assert.ok(labels.some(label=>label.name==='Central Avenue'));
  assert.ok(labels.some(label=>label.name==='New Jersey Avenue'));
  assert.ok(labels.some(label=>/^East \d/.test(label.name)));
  for (let a=0;a<labels.length;a++) {
    assert.ok(labels[a].box.every(point=>point.x>=0&&point.y>=0&&point.x<=width&&point.y<=mapHeight),'Do not paint labels across map/footer boundaries');
    for (let b=a+1;b<labels.length;b++) assert.equal(overlaps(labels[a].box,labels[b].box),false);
  }
  counts.push({width,height,labels:labels.length});
}
assert.equal(JSON.stringify(real),realBefore);

// A broad current view has much less town detail than Fill North Wildwood.
// Keep the northern spit and main avenue recognizable rather than omitting
// both when a full suffix cannot fit a straight stretch at the normal size.
const broadScale=Math.min(2160/(maxX-minX),1674/(maxY-minY))*.5;
const broadProjection=coordinate=>{const p=mercator(coordinate);return{x:(p.x-(minX+maxX)/2)*broadScale+1080,y:(p.y-(minY+maxY)/2)*broadScale+837};};
const broad=layout(realPaths,broadProjection,{x:2160,y:1674},{unit:2},measure);
for (const name of ['New Jersey Avenue','West Spruce Avenue','Central Avenue','New York Avenue']) {
  assert.ok(broad.some(label=>label.name===name),`Wide current views retain ${name}`);
}
assert.equal(broad.find(label=>label.name==='West Spruce Avenue').text,'W Spruce','Conservative fallback retains compass direction and full street name');
for (const label of broad) {
  assert.ok(label.fontSize>=26,'A broad view may use 13px/unit but never unreadably small text');
  assert.ok(label.text===labelName(label.name)||label.text===labelName(label.name).replace(/ Ave$/,''),'Only the standard Avenue suffix may be removed');
}
for (let a=0;a<broad.length;a++) for(let b=a+1;b<broad.length;b++) assert.equal(overlaps(broad[a].box,broad[b].box),false);

// Linux WebKit 27.2's hosted failure used this exact fractional Leaflet camera
// and integer pixel origin. Its New Jersey width was260.1708984375px at30px,
// wider than the Mac font. Sweep the nearby W Spruce metrics whose eligible
// straight window previously fell between the19 fixed fractional candidates.
const hostedZoom=14.743299527888594,hostedOrigin={x:2050693,y:2682369};
const hostedProject=([lng,lat])=>({
  x:Math.round((lng+180)/360*256*2**hostedZoom)-hostedOrigin.x,
  y:Math.round((1-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))/Math.PI)/2*256*2**hostedZoom)-hostedOrigin.y
});
const hostedMetrics30={
  'New Jersey Ave':260.1708984375,'Delaware Ave':231.3720703125,
  'Atlantic Ave':204.345703125,'Ocean Ave':177.7294921875,'E 2nd Ave':167.138671875
};
for (let shortWidth=134;shortWidth<=142;shortWidth++) {
  const metrics=(text,size)=>text==='W Spruce'?shortWidth*size/26
    :hostedMetrics30[text]?hostedMetrics30[text]*size/30:text.length*size*.52*1.2;
  const labels=layout(realPaths,hostedProject,{x:2160,y:1674},{unit:2},metrics);
  const spruce=labels.find(label=>label.name==='West Spruce Avenue');
  assert.ok(spruce,`A${shortWidth}px street name must find its valid straight window between fixed fractions`);
  assert.equal(spruce.text,'W Spruce');assert.equal(spruce.fontSize,26);assert.ok(Math.abs(spruce.width-shortWidth)<1e-9);
  // The real canvas measures at its configured 15px/unit font; it ignores the
  // optional size argument. Layout must scale that measurement for fallbacks.
  const canvasLabels=layout(realPaths,hostedProject,{x:2160,y:1674},{unit:2},text=>metrics(text,30));
  assert.equal(JSON.stringify(canvasLabels),JSON.stringify(labels));
  const jersey=labels.find(label=>label.name==='New Jersey Avenue');
  assert.equal(jersey.x,1055.5952849543178,'An existing accepted major placement stays unchanged');
  assert.equal(jersey.y,965.5127700491962);assert.equal(jersey.fontSize,30);assert.equal(jersey.width,260.1708984375);
  for(let a=0;a<labels.length;a++) {
    assert.ok(labels[a].box.every(point=>point.x>=0&&point.y>=0&&point.x<=2160&&point.y<=1674));
    for(let b=a+1;b<labels.length;b++)assert.equal(overlaps(labels[a].box,labels[b].box),false);
  }
}

// A tile mask uses Leaflet's tile-grid zoom, not the provider's zoomOffset.
// This keeps a 512px/offset-1 tile geographically aligned, including holes.
const ops=[];
const mask={save(){ops.push(['save']);},restore(){ops.push(['restore']);},beginPath(){},moveTo(x,y){ops.push(['move',x,y]);},lineTo(x,y){ops.push(['line',x,y]);},closePath(){},fill(rule){ops.push(['fill',rule]);}};
const tileLayer={_map:{project:([lat,lng],z)=>({x:lng*2**z,y:lat*2**z})},getTileSize:()=>({x:512,y:512}),options:{zoomOffset:-1}};
assert.equal(api.maskReferenceTile(mask,{x:1,y:2,z:3},tileLayer,[[[128,64],[128,96],[160,96]]]),false,'Invalid geographic coordinates cannot erase reference labels');
assert.equal(api.maskReferenceTile(mask,{x:0,y:0,z:3},tileLayer,[[[40,-74],[40,-73],[41,-73]],[[40.2,-73.8],[40.3,-73.8],[40.3,-73.7]]]),true,'Mask is independent of data load for OFF→ON cached tiles');
assert.ok(ops.some(op=>op[0]==='move'&&op[1]===-592&&op[2]===320));
assert.ok(ops.some(op=>op[0]==='fill'&&op[1]==='evenodd'));
assert.equal(api.maskReferenceTile(mask,{x:0,y:0,z:3},{...tileLayer,_map:null},[[[40,-74],[40,-73],[41,-73]]]),false);

// The deadline covers stalled JSON bodies, rejects even if abort is ignored,
// and evicts failures so the next click can fetch fresh authoritative data.
let fetches=0,bodyResolve,deadline,cleared=0,requestedUrl;
const transport=harness({
  setTimeout(callback,delay){assert.equal(delay,15000);deadline=callback;return 7;},clearTimeout(){cleared++;},
  fetch:async(url)=>{fetches++;requestedUrl=url;return{ok:true,json:()=>fetches===1?new Promise(resolve=>{bodyResolve=resolve;}):Promise.resolve(split)};}
});
const first=transport.api.load(),duplicate=transport.api.load();
assert.equal(first,duplicate);
await new Promise(resolve=>setImmediate(resolve));
deadline();
await assert.rejects(first,/too long/);
const retry=await transport.api.load();
assert.equal(fetches,2);assert.ok(retry.length>0);assert.ok(cleared>=2);
assert.equal(requestedUrl,'https://example.test/shorelysafe/floodmapper/north-wildwood/assets/roads/north-wildwood-road-centerlines.geojson');
bodyResolve(collection([feature('Late Stale Road',[[0,0],[1,0]])]));
await new Promise(resolve=>setImmediate(resolve));
assert.equal(await transport.api.load(),retry,'Late timed-out body must not replace successful retry');
assert.equal(fetches,2);

console.log(JSON.stringify({status:'passed',checks:['name-preserving abbreviations','reversed joins, disjoint roads, branches and loops','visible clipped straight stretches','oriented collisions and upright full labels','deterministic GIF positions and PNG scaling','real town coverage at eight dimensions','broad-view major roads with directional suffix fallback','hosted fractional camera and wider font metrics without moving an accepted major','geographic tile masking before load with holes','stalled-body deadline, shared load, retry and stale-body isolation'],realCoverage:counts},null,2));
