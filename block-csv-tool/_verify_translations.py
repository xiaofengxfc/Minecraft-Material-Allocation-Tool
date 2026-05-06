import re, json

with open('block-csv-tool/minecraft-translations.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Extract the object literal
m = re.search(r'MINECRAFT_BLOCK_TRANSLATIONS = (\{[\s\S]*?\})\s*;', content)
if not m:
    print("Could not extract object")
    exit(1)

obj_text = m.group(1)

# Remove JS style comments
cleaned = re.sub(r'//.*?$', '', obj_text, flags=re.MULTILINE)

# Try to parse as JSON directly (it's already valid JSON-like)
# Python dict parsing with proper quoting
obj_text_js = m.group(1)
# Use a more robust approach: find all key-value pairs
pairs = re.findall(r"'([^']+)'\s*:\s*'([^']*)'", obj_text_js)
print(f"Total entries: {len(pairs)}")

keys = [p[0] for p in pairs]
seen = set()
dupes = []
for i, k in enumerate(keys):
    if k in seen:
        dupes.append(k)
    seen.add(k)

print(f"Duplicate keys: {dupes if dupes else 'None'}")

# Check for incomplete categories
# Print entries count by first key prefix patterns
patterns = ['glass', 'wool', 'concrete_powder', 'concrete', 'terracotta', 'glazed',
            'planks', 'fence_gate', 'fence', 'door', 'trapdoor', 'button', 'pressure_plate',
            'sign', 'hanging_sign', 'candle', 'candle_cake', 'copper', 'waxed', 'bed', 'banner', 'wall_banner',
            'coral', 'shulker_box', 'head', 'skull',
            'slab', 'stairs', 'wall', 'leaves', 'sapling',
            'log', '_wood', 'stem', 'hyphae', 'stripped',
            'bamboo', 'cherry', 'mangrove', 'crimson', 'warped',
            'tuff', 'deepslate', 'nether', 'mud', 'sculk', 'amethyst',
            'torch', 'lantern', 'froglight',
            'potted', 'cake',
            'rail', 'ore',
            'sandstone', 'red_sand', 'suspicious',
            'prismarine',
            'stone_brick', 'cobble', 'mossy',
            'granite', 'diorite', 'andesite',
            'purpur', 'end_stone',
            'polished_blackstone',
            'quartz',
            'carpet',
            'shroomlight',
            'nylium', 'fungus', 'roots', 'vines', 'sprouts'
            ]
for p in patterns:
    matches = [k for k in keys if k.startswith(p) or p in k]
    if matches:
        print(f'  "{p}": {len(matches)} entries')

# Check for potential missing items
# All 16 dye colors
colors = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
          'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

# Check which categories have all 16
for cat_prefix in ['stained_glass', 'stained_glass_pane', 'concrete', 'concrete_powder',
                    'shulker_box', 'carpet', 'wool', 'terracotta', 'glazed_terracotta',
                    'bed', 'banner', 'candle', 'candle_cake']:
    cat_keys = []
    for c in colors:
        k = f"{c}_{cat_prefix}" if cat_prefix not in ['candle_cake'] else f"{c}_{cat_prefix}"
        if cat_prefix == 'candle_cake':
            k = f"{c}_candle_cake"
        if k in keys:
            cat_keys.append(k)
    missing = 16 - len(cat_keys)
    if missing:
        print(f'WARNING: {cat_prefix} has {len(cat_keys)}/16 colors (missing {missing})')
    else:
        print(f'  {cat_prefix}: 16/16 complete')