const names: Record<string, string> = {
  icon_seamless: 'DWD ICON',
  ncep_gfs_seamless: 'NOAA GFS',
  'selected-cautious': 'Energrid hourly selection',
  'daily-cautious': 'Energrid daily selection',
};

export function weatherModelName(value: string) {
  const parts = value.split(':');
  const model = parts.find((part) => names[part]);
  return model ? names[model] : value;
}
