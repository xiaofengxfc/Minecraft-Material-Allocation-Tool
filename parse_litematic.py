import gzip, struct, sys
from collections import Counter

filename = sys.argv[1] if len(sys.argv) > 1 else '100w收集.litematic'

with open(filename, 'rb') as f:
    data = gzip.decompress(f.read())

pos = 0

def read_byte():
    global pos
    b = data[pos]; pos += 1; return b

def read_short():
    global pos
    v = struct.unpack('>H', data[pos:pos+2])[0]; pos += 2; return v

def read_int():
    global pos
    v = struct.unpack('>i', data[pos:pos+4])[0]; pos += 4; return v

def read_long():
    global pos
    v = struct.unpack('>q', data[pos:pos+8])[0]; pos += 8; return v

def read_float():
    global pos
    v = struct.unpack('>f', data[pos:pos+4])[0]; pos += 4; return v

def read_double():
    global pos
    v = struct.unpack('>d', data[pos:pos+8])[0]; pos += 8; return v

def read_string():
    global pos
    length = read_short()
    raw = data[pos:pos+length]
    pos += length
    return raw.decode('utf-8', errors='replace')

def parse_value(tag):
    global pos
    if tag == 0:
        return None
    elif tag == 1:
        return read_byte()
    elif tag == 2:
        return read_short()
    elif tag == 3:
        return read_int()
    elif tag == 4:
        return read_long()
    elif tag == 5:
        return read_float()
    elif tag == 6:
        return read_double()
    elif tag == 7:
        length = read_int()
        arr = data[pos:pos+length]
        pos += length
        return arr
    elif tag == 8:
        return read_string()
    elif tag == 9:
        item_type = read_byte()
        length = read_int()
        items = []
        for _ in range(length):
            items.append(parse_value(item_type))
        return items
    elif tag == 10:
        result = {}
        while True:
            t = read_byte()
            if t == 0:
                break
            n = read_string()
            result[n] = parse_value(t)
        return result
    elif tag == 11:
        length = read_int()
        arr = struct.unpack(f'>{length}i', data[pos:pos+length*4])
        pos += length * 4
        return list(arr)
    elif tag == 12:
        length = read_int()
        arr = struct.unpack(f'>{length}q', data[pos:pos+length*8])
        pos += length * 8
        return list(arr)
    return None

# Parse root
tag = read_byte()
name = read_string()
root = parse_value(tag)

print("=== Root keys ===")
for k in root:
    v = root[k]
    if isinstance(v, dict):
        print(f"  {k}: dict ({len(v)} keys)")
    elif isinstance(v, list):
        print(f"  {k}: list ({len(v)} items)")
    elif isinstance(v, bytes):
        print(f"  {k}: bytes ({len(v)} bytes)")
    else:
        print(f"  {k}: {type(v).__name__} = {v}")

regions = root.get('Regions', {})
print(f"\nRegions: {len(regions)} region(s)")

for rname, region in regions.items():
    print(f"\n--- Region: {rname} ---")
    if isinstance(region, dict):
        for k, v in region.items():
            if k == 'Entities':
                print(f"  {k}: list of {len(v)} entities")
            elif k == 'TileEntities':
                print(f"  {k}: list of {len(v)} tile entities")
            elif k == 'PendingBlockTicks':
                print(f"  {k}: list of {len(v)} ticks")
            elif k == 'PendingFluidTicks':
                print(f"  {k}: list of {len(v)} ticks")
            elif k == 'BlockStates':
                bs = v
                palette = bs.get('palette', [])
                print(f"  BlockStates: palette has {len(palette)} entries")
                for i, entry in enumerate(palette):
                    if isinstance(entry, dict):
                        print(f"    [{i}] Name={entry.get('Name','?')} Properties={entry.get('Properties',{})}")
                    else:
                        print(f"    [{i}] {entry}")

                block_data = bs.get('BlockStates', bs.get('blockStates', None))
                if block_data is not None:
                    print(f"  BlockStates raw data: {len(block_data)} longs")
                    palette_size = len(palette)
                    bits_per_block = max(2, (palette_size - 1).bit_length())
                    size = region.get('Size', {})
                    sx, sy, sz = size.get('x', 1), size.get('y', 1), size.get('z', 1)
                    total_blocks = sx * sy * sz
                    print(f"  Region size: {sx}x{sy}x{sz} = {total_blocks} blocks")
                    mask = (1 << bits_per_block) - 1
                    
                    # Decode block data into palette indices
                    # Minecraft 1.16+ uses continuous bitstream across long boundaries,
                    # not per-long fixed-size packing. Combine all longs into one big int.
                    combined = 0
                    for long_val in reversed(block_data):
                        combined = (combined << 64) | long_val
                    
                    indices = []
                    for _ in range(total_blocks):
                        idx = combined & mask
                        indices.append(idx)
                        combined >>= bits_per_block
                    print(f"  Decoded {len(indices)} block indices")
                    
                    # Count blocks
                    counter = Counter()
                    for idx in indices:
                        if 0 <= idx < len(palette):
                            name = palette[idx].get('Name', str(palette[idx])) if isinstance(palette[idx], dict) else str(palette[idx])
                            counter[name] += 1
                    
                    print(f"\n  === Block counts ({len(counter)} unique types) ===")
                    for name, count in counter.most_common(200):
                        print(f"    {count:>6}  {name}")
            else:
                print(f"  {k}: {v}")

print(f"\nParsed up to byte: {pos} / {len(data)}")