import type {
  EstimateApplianceConnectionKind,
  EstimateDeviceInput,
  EstimateLineResult,
  EstimatePanelInput,
  EstimatePointInput,
  EstimateRequestInput,
  EstimateResult,
  EstimateSimpleDeviceKind,
  PricingCatalogRow,
} from './estimate.types';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function safePositive(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid ${field}: ${value}`);
  }
  return value;
}

function mapCatalog(catalog: PricingCatalogRow[]): Map<string, PricingCatalogRow> {
  return new Map(
    catalog
      .filter((row) => row.is_active !== false)
      .map((row) => [row.code, row]),
  );
}

function mustCatalogRow(
  catalogMap: Map<string, PricingCatalogRow>,
  code: string,
): PricingCatalogRow {
  const row = catalogMap.get(code);
  if (!row) {
    throw new Error(`Missing pricing catalog row for code: ${code}`);
  }
  return row;
}

function addLine(
  lines: EstimateLineResult[],
  row: PricingCatalogRow,
  quantity: number,
): void {
  const safeQty = safePositive(quantity, `quantity for ${row.code}`);
  if (safeQty === 0) return;

  const unitPrice = Number(row.base_price);
  const subtotal = round2(safeQty * unitPrice);

  lines.push({
    code: row.code,
    label: row.name_bg,
    quantity: safeQty,
    unit: row.unit,
    unitPrice,
    subtotal,
  });
}

function isApplianceConnectionKind(
  kind: EstimateDeviceInput['kind'],
): kind is EstimateApplianceConnectionKind {
  return (
    kind === 'boiler_connection' ||
    kind === 'stove_connection' ||
    kind === 'ac_connection'
  );
}

function handleSimpleDeviceInput(
  lines: EstimateLineResult[],
  catalogMap: Map<string, PricingCatalogRow>,
  device: EstimateDeviceInput & { kind: EstimateSimpleDeviceKind },
): void {
  const quantity = safePositive(device.quantity, 'device.quantity');
  if (quantity === 0) return;

  const row = mustCatalogRow(catalogMap, device.kind);
  addLine(lines, row, quantity);
}

function handleApplianceConnectionInput(
  lines: EstimateLineResult[],
  catalogMap: Map<string, PricingCatalogRow>,
  device: EstimateDeviceInput & { kind: EstimateApplianceConnectionKind },
): void {
  const quantity = safePositive(device.quantity, 'device.quantity');
  if (quantity === 0) return;

  const baseRow = mustCatalogRow(catalogMap, device.kind);
  addLine(lines, baseRow, quantity);

  const routeLengthMeters = Math.max(
    0,
    safePositive(device.routeLengthMeters ?? 0, 'device.routeLengthMeters'),
  );

  if (routeLengthMeters > 3) {
    const extraMetersPerDevice = routeLengthMeters - 3;
    const extraRow = mustCatalogRow(catalogMap, 'power_line_extra_meter_after_3m');
    addLine(lines, extraRow, quantity * extraMetersPerDevice);
  }

  const wallType = device.wallType ?? 'none';
  if (wallType === 'brick' || wallType === 'concrete') {
    const chaseCode =
      wallType === 'brick'
        ? 'chasing_brick_per_meter'
        : 'chasing_concrete_per_meter';
    const chaseRow = mustCatalogRow(catalogMap, chaseCode);
    addLine(lines, chaseRow, quantity * routeLengthMeters);
  }
}

function handlePointInput(
  lines: EstimateLineResult[],
  catalogMap: Map<string, PricingCatalogRow>,
  point: EstimatePointInput,
): void {
  const quantity = safePositive(point.quantity, 'point.quantity');
  const routeLengthMeters = safePositive(
    point.routeLengthMeters,
    'point.routeLengthMeters',
  );
  const wallType = point.wallType ?? 'none';

  if (quantity === 0) return;

  const baseCode =
    point.kind === 'power_point'
      ? 'power_point_up_to_3m'
      : 'low_current_point_up_to_3m';

  const extraMeterCode =
    point.kind === 'power_point'
      ? 'power_line_extra_meter_after_3m'
      : 'low_current_line_extra_meter_after_3m';

  const baseRow = mustCatalogRow(catalogMap, baseCode);
  addLine(lines, baseRow, quantity);

  if (routeLengthMeters > 3) {
    const extraMetersPerPoint = routeLengthMeters - 3;
    const extraRow = mustCatalogRow(catalogMap, extraMeterCode);
    addLine(lines, extraRow, quantity * extraMetersPerPoint);
  }

  const estimatedChasingMeters =
    routeLengthMeters * (1 + Math.max(0, quantity - 1) * 0.4);

  if (wallType === 'brick') {
    const chaseRow = mustCatalogRow(catalogMap, 'chasing_brick_per_meter');
    addLine(lines, chaseRow, estimatedChasingMeters);
  }

  if (wallType === 'concrete') {
    const chaseRow = mustCatalogRow(catalogMap, 'chasing_concrete_per_meter');
    addLine(lines, chaseRow, estimatedChasingMeters);
  }
}

function handleDeviceInput(
  lines: EstimateLineResult[],
  catalogMap: Map<string, PricingCatalogRow>,
  device: EstimateDeviceInput,
): void {
  if (isApplianceConnectionKind(device.kind)) {
    handleApplianceConnectionInput(lines, catalogMap, device as EstimateDeviceInput & {
      kind: EstimateApplianceConnectionKind;
    });
    return;
  }

  handleSimpleDeviceInput(lines, catalogMap, {
    ...device,
    kind: device.kind as EstimateSimpleDeviceKind,
  });
}

function handlePanelInput(
  lines: EstimateLineResult[],
  catalogMap: Map<string, PricingCatalogRow>,
  panel: EstimatePanelInput,
): void {
  const quantity = safePositive(panel.quantity, 'panel.quantity');
  if (quantity === 0) return;

  const row = mustCatalogRow(catalogMap, panel.kind);
  addLine(lines, row, quantity);
}

function deriveConfidence(input: EstimateRequestInput): 'low' | 'medium' | 'high' {
  const hasPoints = (input.points?.length ?? 0) > 0;
  const hasDevices = (input.devices?.length ?? 0) > 0;
  const hasPanels = (input.panels?.length ?? 0) > 0;

  if (!hasPoints && !hasDevices && !hasPanels) {
    return 'low';
  }

  const hasComplexPoints =
    input.points?.some(
      (p) => p.routeLengthMeters > 3 || (p.wallType ?? 'none') !== 'none',
    ) ?? false;

  const hasComplexDevices =
    input.devices?.some(
      (d) =>
        isApplianceConnectionKind(d.kind) &&
        ((d.routeLengthMeters ?? 0) > 3 || (d.wallType ?? 'none') !== 'none'),
    ) ?? false;

  if (hasComplexPoints || hasComplexDevices) {
    return 'medium';
  }

  return 'high';
}

function deriveAssumptions(input: EstimateRequestInput): string[] {
  const assumptions = new Set<string>();

  assumptions.add('Ориентировъчна цена без оглед.');
  assumptions.add('Материалите не са включени.');

  const hasComplexPoints =
    input.points?.some(
      (p) => p.routeLengthMeters > 3 || (p.wallType ?? 'none') !== 'none',
    ) ?? false;

  const hasComplexDevices =
    input.devices?.some(
      (d) =>
        isApplianceConnectionKind(d.kind) &&
        ((d.routeLengthMeters ?? 0) > 0 || (d.wallType ?? 'none') !== 'none'),
    ) ?? false;

  if (hasComplexPoints || hasComplexDevices) {
    assumptions.add('Дължините и условията на трасетата са приети по подадените данни.');
    assumptions.add('Къртенето е изчислено по ориентировъчен модел със споделени трасета.');
  }

  if (input.includeConsultation) {
    assumptions.add('Включена е платена консултация / оглед.');
  }

  return Array.from(assumptions);
}

export function estimateProject(
  catalog: PricingCatalogRow[],
  input: EstimateRequestInput,
): EstimateResult {
  const catalogMap = mapCatalog(catalog);
  const lines: EstimateLineResult[] = [];

  for (const point of input.points ?? []) {
    handlePointInput(lines, catalogMap, point);
  }

  for (const device of input.devices ?? []) {
    handleDeviceInput(lines, catalogMap, device);
  }

  for (const panel of input.panels ?? []) {
    handlePanelInput(lines, catalogMap, panel);
  }

  if (input.includeConsultation) {
    const row = mustCatalogRow(catalogMap, 'onsite_consultation_paid');
    addLine(lines, row, 1);
  }

  const subtotal = round2(
    lines.reduce((sum, line) => sum + Number(line.subtotal), 0),
  );

  return {
    currency: 'EUR',
    subtotal,
    confidence: deriveConfidence(input),
    needsInspection: true,
    assumptions: deriveAssumptions(input),
    lines,
  };
}
