// Build the one-foot North Wildwood hydraulic terrain graph.
//
// The terrain is quantized only for graph topology (0.1 ft NAVD88).  Source
// blocks follow the literal four-neighbour rule: a <=1.0 ft component must
// contain at least 101 cells and intersect a supplied source-block polygon.
// Bulkhead pixels are raised to 7.5 ft.  Grates remain separate 48-inch
// orifices but act as equilibrium connectivity seeds.

#include "gdal_priv.h"
#include "cpl_conv.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

constexpr int16_t NODATA_ELEV = std::numeric_limits<int16_t>::min();
constexpr int16_t NO_CONNECTION = std::numeric_limits<int16_t>::max();
constexpr int32_t INACTIVE = std::numeric_limits<int32_t>::min();
constexpr int16_t SOURCE_STAGE10 = 10;
constexpr int16_t BULKHEAD_STAGE10 = 75;
constexpr int16_t MODEL_MAX10 = 140;
constexpr int16_t HIST_MIN10 = -100;
constexpr int16_t HIST_MAX10 = 140;
constexpr int HIST_BINS = HIST_MAX10 - HIST_MIN10 + 1;
constexpr int32_t SOURCE_MIN_CELLS = 101;
constexpr int CONTROL_VOLUME_SIZE_FT = 25;
constexpr int CONNECTION_BIN10 = 20;

struct Inputs {
  fs::path dem;
  fs::path source;
  fs::path hard;
  fs::path grates;
  fs::path output;
};

struct RasterInfo {
  int width = 0;
  int height = 0;
  std::array<double, 6> geotransform{};
  std::string projection;
};

struct Dsu {
  std::vector<int32_t> parent;
  std::vector<int32_t> head;
  std::vector<int32_t> tail;
  std::vector<int32_t> next;
  std::vector<uint8_t> connected;

  explicit Dsu(size_t count)
      : parent(count, INACTIVE),
        head(count, -1),
        tail(count, -1),
        next(count, -1),
        connected(count, 0) {}

  int32_t find(int32_t value) {
    int32_t root = value;
    while (parent[root] >= 0) root = parent[root];
    while (value != root) {
      int32_t following = parent[value];
      parent[value] = root;
      value = following;
    }
    return root;
  }
};

struct ZoneSummary {
  int16_t connection10 = NO_CONNECTION;
  uint64_t cell_count = 0;
  uint64_t source_cells = 0;
  uint64_t grate_cells = 0;
  uint64_t hard_cells = 0;
  std::array<uint64_t, HIST_BINS> histogram{};
};

Inputs parse_args(int argc, char** argv) {
  Inputs result;
  for (int index = 1; index + 1 < argc; index += 2) {
    const std::string key = argv[index];
    const fs::path value = argv[index + 1];
    if (key == "--dem") result.dem = value;
    else if (key == "--source") result.source = value;
    else if (key == "--hard") result.hard = value;
    else if (key == "--grates") result.grates = value;
    else if (key == "--output") result.output = value;
    else throw std::runtime_error("Unknown argument: " + key);
  }
  if (result.dem.empty() || result.source.empty() || result.hard.empty() ||
      result.grates.empty() || result.output.empty()) {
    throw std::runtime_error(
        "Usage: north_wildwood_hydraulic_graph --dem DEM --source MASK "
        "--hard MASK --grates MASK --output DIRECTORY");
  }
  return result;
}

GDALDataset* open_raster(const fs::path& path) {
  GDALDataset* dataset = static_cast<GDALDataset*>(
      GDALOpen(path.string().c_str(), GA_ReadOnly));
  if (!dataset) throw std::runtime_error("Could not open " + path.string());
  return dataset;
}

RasterInfo read_dem(
    const fs::path& path,
    std::vector<int16_t>& elevation10) {
  GDALDataset* dataset = open_raster(path);
  RasterInfo info;
  info.width = dataset->GetRasterXSize();
  info.height = dataset->GetRasterYSize();
  if (dataset->GetGeoTransform(info.geotransform.data()) != CE_None) {
    GDALClose(dataset);
    throw std::runtime_error("DEM has no geotransform");
  }
  info.projection = dataset->GetProjectionRef();
  const size_t count = static_cast<size_t>(info.width) * info.height;
  std::vector<float> source(count);
  GDALRasterBand* band = dataset->GetRasterBand(1);
  int has_nodata = 0;
  const double nodata = band->GetNoDataValue(&has_nodata);
  if (band->RasterIO(
          GF_Read, 0, 0, info.width, info.height, source.data(),
          info.width, info.height, GDT_Float32, 0, 0) != CE_None) {
    GDALClose(dataset);
    throw std::runtime_error("Could not read DEM");
  }
  GDALClose(dataset);
  elevation10.resize(count, NODATA_ELEV);
  uint64_t valid_count = 0;
  for (size_t index = 0; index < count; ++index) {
    const float value = source[index];
    if (!std::isfinite(value) || (has_nodata && value == static_cast<float>(nodata))) continue;
    elevation10[index] = static_cast<int16_t>(std::clamp(
        static_cast<int>(std::lround(value * 10.0)), -300, 300));
    ++valid_count;
  }
  std::cout << "Loaded " << valid_count << " valid one-foot DEM cells\n";
  return info;
}

std::vector<uint8_t> read_mask(
    const fs::path& path,
    const RasterInfo& info) {
  GDALDataset* dataset = open_raster(path);
  if (dataset->GetRasterXSize() != info.width ||
      dataset->GetRasterYSize() != info.height) {
    GDALClose(dataset);
    throw std::runtime_error("Mask dimensions do not match DEM: " + path.string());
  }
  const size_t count = static_cast<size_t>(info.width) * info.height;
  std::vector<uint8_t> values(count);
  if (dataset->GetRasterBand(1)->RasterIO(
          GF_Read, 0, 0, info.width, info.height, values.data(),
          info.width, info.height, GDT_Byte, 0, 0) != CE_None) {
    GDALClose(dataset);
    throw std::runtime_error("Could not read mask " + path.string());
  }
  GDALClose(dataset);
  for (uint8_t& value : values) value = value ? 1 : 0;
  return values;
}

template <typename T>
void write_raw(const fs::path& path, const std::vector<T>& values) {
  std::ofstream stream(path, std::ios::binary);
  if (!stream) throw std::runtime_error("Could not create " + path.string());
  stream.write(
      reinterpret_cast<const char*>(values.data()),
      static_cast<std::streamsize>(values.size() * sizeof(T)));
  if (!stream) throw std::runtime_error("Could not write " + path.string());
}

void write_geotiff(
    const fs::path& path,
    const void* values,
    const RasterInfo& info,
    GDALDataType type,
    double nodata,
    const std::string& description) {
  char** options = nullptr;
  options = CSLSetNameValue(options, "TILED", "YES");
  options = CSLSetNameValue(options, "BLOCKXSIZE", "512");
  options = CSLSetNameValue(options, "BLOCKYSIZE", "512");
  options = CSLSetNameValue(options, "COMPRESS", "ZSTD");
  options = CSLSetNameValue(options, "BIGTIFF", "YES");
  GDALDriver* driver = GetGDALDriverManager()->GetDriverByName("GTiff");
  GDALDataset* output = driver->Create(
      path.string().c_str(), info.width, info.height, 1, type, options);
  CSLDestroy(options);
  if (!output) throw std::runtime_error("Could not create " + path.string());
  output->SetGeoTransform(const_cast<double*>(info.geotransform.data()));
  output->SetProjection(info.projection.c_str());
  GDALRasterBand* band = output->GetRasterBand(1);
  band->SetNoDataValue(nodata);
  band->SetDescription(description.c_str());
  if (band->RasterIO(
          GF_Write, 0, 0, info.width, info.height, const_cast<void*>(values),
          info.width, info.height, type, 0, 0) != CE_None) {
    GDALClose(output);
    throw std::runtime_error("Could not write " + path.string());
  }
  GDALClose(output);
}

inline bool is_valid(int16_t value) {
  return value != NODATA_ELEV;
}

void condition_bulkheads(
    std::vector<int16_t>& elevation10,
    const std::vector<uint8_t>& hard) {
  uint64_t raised = 0;
  for (size_t index = 0; index < elevation10.size(); ++index) {
    if (hard[index] && is_valid(elevation10[index]) &&
        elevation10[index] < BULKHEAD_STAGE10) {
      elevation10[index] = BULKHEAD_STAGE10;
      ++raised;
    }
  }
  std::cout << "Raised " << raised << " bulkhead cells to 7.5 ft NAVD88\n";
}

std::vector<uint8_t> find_source_blocks(
    const std::vector<int16_t>& elevation10,
    const std::vector<uint8_t>& manual,
    int width,
    int height) {
  const size_t count = elevation10.size();
  std::vector<uint8_t> state(count, 0);
  std::vector<int32_t> component;
  uint64_t qualifying_components = 0;
  uint64_t qualifying_cells = 0;
  const auto add = [&](int32_t index, std::vector<int32_t>& queue) {
    state[index] = 1;
    queue.push_back(index);
  };

  for (int32_t seed = 0; seed < static_cast<int32_t>(count); ++seed) {
    if (state[seed] || !is_valid(elevation10[seed]) ||
        elevation10[seed] > SOURCE_STAGE10) continue;
    component.clear();
    add(seed, component);
    bool hits_manual = manual[seed] != 0;
    for (size_t cursor = 0; cursor < component.size(); ++cursor) {
      const int32_t current = component[cursor];
      const int x = current % width;
      const int y = current / width;
      const std::array<int32_t, 4> neighbours = {
          x > 0 ? current - 1 : -1,
          x + 1 < width ? current + 1 : -1,
          y > 0 ? current - width : -1,
          y + 1 < height ? current + width : -1};
      for (const int32_t neighbour : neighbours) {
        if (neighbour < 0 || state[neighbour] ||
            !is_valid(elevation10[neighbour]) ||
            elevation10[neighbour] > SOURCE_STAGE10) continue;
        add(neighbour, component);
        hits_manual = hits_manual || manual[neighbour];
      }
    }
    if (component.size() >= SOURCE_MIN_CELLS && hits_manual) {
      ++qualifying_components;
      qualifying_cells += component.size();
      for (const int32_t cell : component) state[cell] = 2;
    }
  }
  for (uint8_t& value : state) value = value == 2 ? 1 : 0;
  std::cout << "Qualified " << qualifying_components << " source components ("
            << qualifying_cells << " cells)\n";
  return state;
}

void assign_component(
    Dsu& dsu,
    int32_t root,
    int16_t stage10,
    std::vector<int16_t>& connection10) {
  for (int32_t cell = dsu.head[root]; cell >= 0; cell = dsu.next[cell]) {
    connection10[cell] = stage10;
  }
  dsu.head[root] = -1;
  dsu.tail[root] = -1;
}

int32_t unite(
    Dsu& dsu,
    int32_t a,
    int32_t b,
    int16_t stage10,
    std::vector<int16_t>& connection10) {
  int32_t root_a = dsu.find(a);
  int32_t root_b = dsu.find(b);
  if (root_a == root_b) return root_a;
  if (dsu.parent[root_a] > dsu.parent[root_b]) std::swap(root_a, root_b);

  const bool a_connected = dsu.connected[root_a];
  const bool b_connected = dsu.connected[root_b];
  dsu.parent[root_a] += dsu.parent[root_b];
  dsu.parent[root_b] = root_a;
  dsu.connected[root_a] = a_connected || b_connected;

  if (a_connected && !b_connected) {
    assign_component(dsu, root_b, stage10, connection10);
  } else if (!a_connected && b_connected) {
    assign_component(dsu, root_a, stage10, connection10);
  } else if (!a_connected && !b_connected && dsu.head[root_b] >= 0) {
    if (dsu.head[root_a] < 0) {
      dsu.head[root_a] = dsu.head[root_b];
      dsu.tail[root_a] = dsu.tail[root_b];
    } else {
      dsu.next[dsu.tail[root_a]] = dsu.head[root_b];
      dsu.tail[root_a] = dsu.tail[root_b];
    }
  }
  if (dsu.connected[root_a]) {
    dsu.head[root_a] = -1;
    dsu.tail[root_a] = -1;
  }
  dsu.head[root_b] = -1;
  dsu.tail[root_b] = -1;
  return root_a;
}

std::vector<int16_t> build_connection_stage(
    const std::vector<int16_t>& elevation10,
    const std::vector<uint8_t>& source,
    const std::vector<uint8_t>& grates,
    int width,
    int height) {
  const size_t count = elevation10.size();
  int16_t minimum = MODEL_MAX10;
  for (const int16_t value : elevation10) {
    if (is_valid(value) && value <= MODEL_MAX10) minimum = std::min(minimum, value);
  }
  std::vector<std::vector<int32_t>> buckets(MODEL_MAX10 - minimum + 1);
  for (int32_t index = 0; index < static_cast<int32_t>(count); ++index) {
    const int16_t value = elevation10[index];
    if (is_valid(value) && value <= MODEL_MAX10) {
      buckets[value - minimum].push_back(index);
    }
  }

  Dsu dsu(count);
  std::vector<int16_t> connection10(count, NO_CONNECTION);
  for (int16_t stage10 = minimum; stage10 <= MODEL_MAX10; ++stage10) {
    const auto& cells = buckets[stage10 - minimum];
    for (const int32_t cell : cells) {
      const bool seed = source[cell] || grates[cell];
      dsu.parent[cell] = -1;
      dsu.connected[cell] = seed ? 1 : 0;
      if (seed) {
        connection10[cell] = stage10;
      } else {
        dsu.head[cell] = cell;
        dsu.tail[cell] = cell;
      }
    }
    for (const int32_t cell : cells) {
      const int x = cell % width;
      const int y = cell / width;
      if (x > 0 && dsu.parent[cell - 1] != INACTIVE) {
        unite(dsu, cell, cell - 1, stage10, connection10);
      }
      if (x + 1 < width && dsu.parent[cell + 1] != INACTIVE) {
        unite(dsu, cell, cell + 1, stage10, connection10);
      }
      if (y > 0 && dsu.parent[cell - width] != INACTIVE) {
        unite(dsu, cell, cell - width, stage10, connection10);
      }
      if (y + 1 < height && dsu.parent[cell + width] != INACTIVE) {
        unite(dsu, cell, cell + width, stage10, connection10);
      }
    }
    if ((stage10 - minimum) % 10 == 0 || stage10 == MODEL_MAX10) {
      std::cout << "Connected terrain through " << stage10 / 10.0 << " ft\n";
    }
  }
  return connection10;
}

std::vector<int32_t> build_zones(
    const std::vector<int16_t>& elevation10,
    const std::vector<int16_t>& connection10,
    const std::vector<uint8_t>& source,
    const std::vector<uint8_t>& grates,
    const std::vector<uint8_t>& hard,
    int width,
    int height,
    std::vector<ZoneSummary>& summaries) {
  const size_t count = elevation10.size();
  std::vector<int32_t> zone(count, -1);
  const int tiles_x = (width + CONTROL_VOLUME_SIZE_FT - 1) / CONTROL_VOLUME_SIZE_FT;
  const int tiles_y = (height + CONTROL_VOLUME_SIZE_FT - 1) / CONTROL_VOLUME_SIZE_FT;
  const int connection_bins =
      (HIST_MAX10 - HIST_MIN10) / CONNECTION_BIN10 + 1;
  std::vector<int32_t> key_to_zone(
      static_cast<size_t>(tiles_x) * tiles_y * connection_bins, -1);
  for (int32_t cell = 0; cell < static_cast<int32_t>(count); ++cell) {
    if (connection10[cell] == NO_CONNECTION) continue;
    const int x = cell % width;
    const int y = cell / width;
    const int tile_id =
        (y / CONTROL_VOLUME_SIZE_FT) * tiles_x +
        (x / CONTROL_VOLUME_SIZE_FT);
    const int16_t clipped_connection =
        std::clamp(connection10[cell], HIST_MIN10, HIST_MAX10);
    const int connection_bin =
        (clipped_connection - HIST_MIN10) / CONNECTION_BIN10;
    const size_t key =
        static_cast<size_t>(tile_id) * connection_bins + connection_bin;
    int32_t zone_id = key_to_zone[key];
    if (zone_id < 0) {
      zone_id = static_cast<int32_t>(summaries.size());
      key_to_zone[key] = zone_id;
      summaries.emplace_back();
      summaries.back().connection10 = connection10[cell];
    }
    zone[cell] = zone_id;
    ZoneSummary& summary = summaries[zone_id];
    summary.connection10 = std::max(summary.connection10, connection10[cell]);
    ++summary.cell_count;
    summary.source_cells += source[cell];
    summary.grate_cells += grates[cell];
    summary.hard_cells += hard[cell];
    const int16_t clamped = std::clamp(elevation10[cell], HIST_MIN10, HIST_MAX10);
    ++summary.histogram[clamped - HIST_MIN10];
  }
  std::cout << "Built " << summaries.size()
            << " one-foot-hypsometry control volumes ("
            << CONTROL_VOLUME_SIZE_FT << " ft spatial tiles, "
            << CONNECTION_BIN10 / 10.0 << " ft connection bins)\n";
  return zone;
}

void write_zones(
    const fs::path& path,
    const std::vector<ZoneSummary>& summaries) {
  std::ofstream stream(path);
  stream << "zone_id,connection10,cell_count,source_cells,grate_cells,hard_cells,hist_min10,hist_counts\n";
  for (size_t zone_id = 0; zone_id < summaries.size(); ++zone_id) {
    const ZoneSummary& row = summaries[zone_id];
    stream << zone_id << ',' << row.connection10 << ',' << row.cell_count << ','
           << row.source_cells << ',' << row.grate_cells << ',' << row.hard_cells
           << ',' << HIST_MIN10 << ',';
    for (int index = 0; index < HIST_BINS; ++index) {
      if (index) stream << ':';
      stream << row.histogram[index];
    }
    stream << '\n';
  }
}

void write_edges(
    const fs::path& path,
    const std::vector<int16_t>& elevation10,
    const std::vector<int32_t>& zone,
    int width,
    int height) {
  std::vector<uint64_t> samples;
  samples.reserve(zone.size() / 12);
  auto collect = [&](int32_t cell, int32_t neighbour) {
    const int32_t zone_a_raw = zone[cell];
    const int32_t zone_b_raw = zone[neighbour];
    if (zone_a_raw < 0 || zone_b_raw < 0 || zone_a_raw == zone_b_raw) return;
    const uint32_t zone_a = std::min(zone_a_raw, zone_b_raw);
    const uint32_t zone_b = std::max(zone_a_raw, zone_b_raw);
    if (zone_a >= (1u << 28) || zone_b >= (1u << 28)) {
      throw std::runtime_error("Too many zones for packed edge encoding");
    }
    const int16_t crest10 = std::clamp(
        std::max(elevation10[cell], elevation10[neighbour]),
        HIST_MIN10, HIST_MAX10);
    const uint8_t crest_code = static_cast<uint8_t>(crest10 - HIST_MIN10);
    samples.push_back(
        (static_cast<uint64_t>(zone_a) << 36) |
        (static_cast<uint64_t>(zone_b) << 8) |
        crest_code);
  };
  for (int y = 0; y < height; ++y) {
    for (int x = 0; x < width; ++x) {
      const int32_t cell = y * width + x;
      if (x + 1 < width) collect(cell, cell + 1);
      if (y + 1 < height) collect(cell, cell + width);
    }
  }
  std::sort(samples.begin(), samples.end());
  std::ofstream stream(path);
  stream << "zone_a,zone_b,crest10,width_ft\n";
  size_t index = 0;
  while (index < samples.size()) {
    size_t end = index + 1;
    while (end < samples.size() && samples[end] == samples[index]) ++end;
    const uint64_t key = samples[index];
    const uint32_t zone_a = static_cast<uint32_t>(key >> 36);
    const uint32_t zone_b = static_cast<uint32_t>((key >> 8) & ((1ull << 28) - 1));
    const int16_t crest10 = static_cast<int16_t>((key & 0xff) + HIST_MIN10);
    stream << zone_a << ',' << zone_b << ',' << crest10 << ',' << end - index << '\n';
    index = end;
  }
  std::cout << "Aggregated " << samples.size() << " shared one-foot edge segments\n";
}

void write_manifest(
    const fs::path& path,
    const RasterInfo& info,
    size_t zone_count) {
  std::ofstream stream(path);
  stream << "{\n"
         << "  \"schema\": \"north-wildwood-one-foot-hydraulic-graph-v1\",\n"
         << "  \"width\": " << info.width << ",\n"
         << "  \"height\": " << info.height << ",\n"
         << "  \"cellSizeFt\": 1,\n"
         << "  \"sourceStageNavd88Ft\": 1.0,\n"
         << "  \"sourceMinComponentCells\": 101,\n"
         << "  \"sourceConnectivity\": \"four-neighbour/shared-side only\",\n"
         << "  \"bulkheadElevationNavd88Ft\": 7.5,\n"
         << "  \"grateDiameterInches\": 48,\n"
         << "  \"modelMaximumNavd88Ft\": 14.0,\n"
         << "  \"controlVolumeSizeFt\": " << CONTROL_VOLUME_SIZE_FT << ",\n"
         << "  \"connectionBinFt\": " << CONNECTION_BIN10 / 10.0 << ",\n"
         << "  \"zoneCount\": " << zone_count << ",\n"
         << "  \"geotransform\": [";
  for (size_t index = 0; index < info.geotransform.size(); ++index) {
    if (index) stream << ", ";
    stream << info.geotransform[index];
  }
  stream << "]\n}\n";
}

int main(int argc, char** argv) {
  try {
    GDALAllRegister();
    const Inputs inputs = parse_args(argc, argv);
    fs::create_directories(inputs.output);
    std::vector<int16_t> elevation10;
    const RasterInfo info = read_dem(inputs.dem, elevation10);
    std::vector<uint8_t> manual = read_mask(inputs.source, info);
    std::vector<uint8_t> hard = read_mask(inputs.hard, info);
    std::vector<uint8_t> grates = read_mask(inputs.grates, info);
    condition_bulkheads(elevation10, hard);
    std::vector<uint8_t> source = find_source_blocks(
        elevation10, manual, info.width, info.height);
    manual.clear();
    manual.shrink_to_fit();

    std::vector<int16_t> connection10 = build_connection_stage(
        elevation10, source, grates, info.width, info.height);
    std::vector<ZoneSummary> summaries;
    std::vector<int32_t> zone = build_zones(
        elevation10, connection10, source, grates, hard,
        info.width, info.height, summaries);

    write_raw(inputs.output / "elevation10.raw", elevation10);
    write_raw(inputs.output / "connection10.raw", connection10);
    write_raw(inputs.output / "zone_id.raw", zone);
    write_raw(inputs.output / "source_flag.raw", source);
    write_raw(inputs.output / "hard_flag.raw", hard);
    write_raw(inputs.output / "grate_flag.raw", grates);
    write_zones(inputs.output / "zones.csv", summaries);
    write_edges(inputs.output / "edges.csv", elevation10, zone, info.width, info.height);
    write_manifest(inputs.output / "graph_manifest.json", info, summaries.size());

    write_geotiff(
        inputs.output / "NorthWildwoodConditionedElevation10.tif",
        elevation10.data(), info, GDT_Int16, NODATA_ELEV,
        "conditioned_ground_elevation_navd88_decifeet");
    write_geotiff(
        inputs.output / "NorthWildwoodConnectionStage10.tif",
        connection10.data(), info, GDT_Int16, NO_CONNECTION,
        "first_equilibrium_connection_stage_navd88_decifeet");
    write_geotiff(
        inputs.output / "NorthWildwoodHydraulicZone.tif",
        zone.data(), info, GDT_Int32, -1,
        "hydraulic_zone_id");
    write_geotiff(
        inputs.output / "NorthWildwoodSourceBlocks.tif",
        source.data(), info, GDT_Byte, 0,
        "qualified_source_block_flag");
    write_geotiff(
        inputs.output / "NorthWildwoodBulkheads.tif",
        hard.data(), info, GDT_Byte, 0,
        "bulkhead_7_5ft_navd88_flag");
    write_geotiff(
        inputs.output / "NorthWildwoodStormGrates.tif",
        grates.data(), info, GDT_Byte, 0,
        "storm_grate_48inch_flag");
    std::cout << "Hydraulic graph complete\n";
    return 0;
  } catch (const std::exception& error) {
    std::cerr << "ERROR: " << error.what() << '\n';
    return 1;
  }
}
