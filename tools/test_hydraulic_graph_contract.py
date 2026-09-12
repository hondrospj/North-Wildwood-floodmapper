"""Compile the actual graph implementation and test encoding and raster alignment."""
from pathlib import Path
import subprocess
import shlex
import tempfile
import shutil
import json

root=Path(__file__).resolve().parents[1]
config=shutil.which('gdal-config')
if not config:raise RuntimeError('gdal-config is required for graph contract tests')
with tempfile.TemporaryDirectory() as directory:
    temp=Path(directory);source=temp/'contract.cpp'
    source.write_text('''#define main floodmapper_graph_cli_main
#include '''+json.dumps(str(root/'tools/north_wildwood_hydraulic_graph.cpp'))+'''
#undef main
#include <sstream>
int main(int argc, char** argv) {
  GDALAllRegister();
  const fs::path output = fs::path(argv[1]) / "edges.csv";
  for (int16_t stage = HIST_MIN10; stage <= HIST_MAX10; ++stage) {
    write_edges(output, {stage, stage}, {0, 1}, 2, 1);
    std::ifstream file(output); std::string line;
    std::getline(file,line); std::getline(file,line);
    std::stringstream fields(line); std::string a,b,height;
    std::getline(fields,a,','); std::getline(fields,b,','); std::getline(fields,height,',');
    if (std::stoi(height) != stage) throw std::runtime_error("Edge crest round-trip failed");
  }
  RasterInfo info; info.width=2; info.height=1;
  info.geotransform={0,1,0,1,0,-1};
  OGRSpatialReference srs; srs.importFromEPSG(6527);
  char* wkt=nullptr; srs.exportToWkt(&wkt); info.projection=wkt; CPLFree(wkt);
  const auto path=fs::path(argv[1])/"mask.tif";
  auto* driver=GetGDALDriverManager()->GetDriverByName("GTiff");
  for (int invalid=0; invalid<3; ++invalid) {
    auto* ds=driver->Create(path.c_str(),2,1,1,GDT_Byte,nullptr);
    auto transform=info.geotransform; if(invalid==1)transform[0]+=1;
    ds->SetGeoTransform(transform.data());
    OGRSpatialReference other; other.importFromEPSG(invalid==2?4326:6527);
    ds->SetSpatialRef(&other); ds->GetRasterBand(1)->SetNoDataValue(255);
    uint8_t values[2]={1,255};
    if(ds->GetRasterBand(1)->RasterIO(GF_Write,0,0,2,1,values,2,1,GDT_Byte,0,0)!=CE_None) return 2;
    GDALClose(ds);
    bool rejected=false;
    try { auto actual=read_mask(path,info); if(actual[0]!=1||actual[1]!=0) throw std::logic_error("Nodata mask failed"); }
    catch(const std::runtime_error&) {rejected=true;}
    if (rejected!=(invalid!=0)) throw std::logic_error("Mask alignment contract failed");
  }
}
''')
    flags=shlex.split(subprocess.check_output([config,'--cflags'],text=True))+shlex.split(subprocess.check_output([config,'--libs'],text=True))
    flags += ['-Wl,-rpath,'+flag[2:] for flag in flags if flag.startswith('-L')]
    executable=temp/'contract'
    subprocess.run([shutil.which('clang++') or 'c++','-std=c++17','-O1',str(source),'-o',str(executable),*flags],check=True)
    result=subprocess.run([str(executable),str(temp)],capture_output=True,text=True)
    if result.returncode:
        raise RuntimeError(result.stderr + result.stdout[-1500:])
    print('Graph contracts passed: all 301 crest codes, transform/CRS mismatch rejection, and nodata handling')
