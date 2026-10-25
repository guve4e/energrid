import { BadRequestException, ForbiddenException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { utcInstant, type ElectricalMetric } from '@energrid/domain-telemetry';
import { TelemetryStore } from '../telemetry/telemetry.store';
import { DeviceRegistryService } from '../devices/device-registry.service';

const metrics: ElectricalMetric[] = ['power', 'energy_import_total', 'energy_export_total'];
const maxRangeMs = 7 * 24 * 60 * 60_000;

@Injectable()
export class PortalDeviceElectricalMeasurementsService {
  constructor(private readonly registry: DeviceRegistryService, private readonly telemetry: TelemetryStore) {}

  async history(deviceId: string, metricValue: unknown, fromValue: unknown, toValue: unknown) {
    const metric = metricValue as ElectricalMetric;
    if (!metrics.includes(metric)) throw new BadRequestException('Choose a supported electrical metric.');
    let from: string, to: string;
    try {
      from = utcInstant(fromValue);
      to = utcInstant(toValue);
      const span = Date.parse(to) - Date.parse(from);
      if (span <= 0 || span > maxRangeMs || Date.parse(to) > Date.now() + 30_000) throw new Error();
    } catch {
      throw new BadRequestException('Choose a past UTC range of up to seven days.');
    }
    const { tenant, site } = this.registry.getSnapshot();
    const device = this.registry.getDevices().find(candidate => candidate.id === deviceId && candidate.tenantId === tenant.id && candidate.siteId === site.id);
    if (!device || device.kind !== 'physical' || device.trustStatus !== 'approved') throw new NotFoundException('Approved device was not found in this site.');
    const supported = (device.supportedCapabilities ?? device.capabilities).some(capability => capability.kind === 'power');
    if (!supported) throw new NotFoundException('This device has no verified electrical measurement capability.');
    const authorized = device.capabilities.some(capability => capability.kind === 'power' && capability.actions.includes('read'));
    if (!authorized) throw new ForbiddenException('Electrical readings are not authorized for this device.');
    const channel = String(device.metadata?.component ?? (device.metadata?.channel === undefined ? '' : `em1:${device.metadata.channel}`));
    if (!/^(?:em1|switch):\d+$/.test(channel)) throw new ServiceUnavailableException('A verified electrical channel is not available.');
    try {
      const readings = await this.telemetry.read({ tenantId: tenant.id, siteId: site.id, deviceId, channel, metric }, from, to);
      const measured = readings.filter(reading => reading.quality === 'measured' && typeof reading.value === 'number' && Number.isFinite(reading.value));
      // Bound chart payload size while preserving the time order and full range.
      const stride = Math.max(1, Math.ceil(measured.length / 1200));
      const points = measured.filter((_, index) => index % stride === 0 || index === measured.length - 1)
        .map(reading => ({ observedAt: reading.observedAt, value: reading.value, unit: reading.unit }));
      return { deviceId, metric, unit: readings[0]?.unit ?? (metric === 'power' ? 'W' : 'kWh'), from, to, measurements: points };
    } catch {
      throw new ServiceUnavailableException('Electrical measurement history is unavailable.');
    }
  }
}
