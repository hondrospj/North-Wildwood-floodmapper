from pathlib import Path
import sys,tempfile,json,unittest,ast
import numpy as np
root=Path(__file__).resolve().parents[2];sys.path.insert(0,str(root/'model/src'))
from cache_contract import spatial_lookup_fingerprint,terrain_manifest_matches,terrain_config_fingerprint,sha256_file
class CacheTests(unittest.TestCase):
 def test_same_shape_moved_mesh_has_different_key(self):
  points=np.array([[0.,0.],[1.,1.]])
  def key(p,transform=(1,0,0,0,-1,0),crs='EPSG:6347'):
   return spatial_lookup_fingerprint(p,transform,crs,slice(0,2),slice(0,3))
  self.assertNotEqual(key(points),key(points+1));self.assertNotEqual(key(points),key(points,(1,0,1,0,-1,0)))
  self.assertNotEqual(key(points),key(points,crs='EPSG:4326'));self.assertEqual(key(points),key(points.copy()))
 def test_terrain_configuration_or_content_invalidates_cache(self):
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);(p/'model/src').mkdir(parents=True);(p/'model/src/prepare_terrain.py').write_text('builder')
   (p/'dem').write_text('source');(p/'output').write_text('output');config={'terrain':{'crest':2}}
   def record(name):return {'path':name,'sha256':sha256_file(p/name)}
   manifest={'configSha256':terrain_config_fingerprint(config),'builderSha256':sha256_file(p/'model/src/prepare_terrain.py'),
    'inputs':{'dem':record('dem')},'outputs':{'out':record('output')},'tileFingerprints':[record('dem')]}
   self.assertTrue(terrain_manifest_matches(p,config,manifest));self.assertFalse(terrain_manifest_matches(p,{'terrain':{'crest':3}},manifest))
   (p/'dem').write_text('changed');self.assertFalse(terrain_manifest_matches(p,config,manifest))
 def test_first_arrival_survives_drying_and_rewetting(self):
  tree=ast.parse((root/'model/src/run_anuga.py').read_text())
  statements=[n for n in ast.walk(tree) if isinstance(n,ast.Assign) and any('first_arrival' in ast.unparse(t) or 'arrival_time_seconds[first_arrival]' in ast.unparse(t) for t in n.targets)]
  statements.sort(key=lambda n:n.lineno);self.assertEqual(len(statements),2)
  code=compile(ast.Module(body=statements,type_ignores=[]),'run_anuga.py','exec')
  state={'arrival_time_seconds':np.array([-1.,-1.])}
  for t,wet in [(0,[True,False]),(15,[False,False]),(30,[True,True])]:
   state.update(model_time=t,wet=np.array(wet));exec(code,state)
  np.testing.assert_equal(state['arrival_time_seconds'],[0,30])
if __name__=='__main__':unittest.main()
