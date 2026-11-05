import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { ElectricalMetric } from '@energrid/domain-telemetry';
import { DeviceRegistryService } from '../devices/device-registry.service';
import { PortalDeviceMeasurementsService } from './portal-device-measurements.service';

const metrics: ElectricalMetric[] = ['power', 'energy_import_total', 'energy_export_total'];
const maxHistoryRows = 5000;
const maxChartPoints = 1200;

/** Compatibility response for the existing electrical chart, backed by generic measurement history. */
@Injectable()
export class PortalDeviceElectricalMeasurementsService {
  constructor(
    private readonly registry: DeviceRegistryService,
    private readonly measurements: PortalDeviceMeasurementsService,
  ) {}

  async history(deviceId: string, metricValue: unknown, fromValue: unknown, toValue: unknown) {
    if (!metrics.includes(metricValue as ElectricalMetric)) {
      throw new BadRequestException('Choose a supported electrical metric.');
    }
    const metric = metricValue as ElectricalMetric;
    const { tenant, site } = this.registry.getSnapshot();
    const device = this.registry.getDevices().find(candidate =>
      candidate.id === deviceId && candidate.tenantId === tenant.id && candidate.siteId === site.id,
    );
    if (!device || device.kind !== 'physical' || device.trustStatus !== 'approved') {
      throw new NotFoundException('Approved device was not found in this site.');
    }
    const supported = (device.supportedCapabilities ?? device.capabilities).some(capability => capability.kind === 'power');
    if (!supported) throw new NotFoundException('This device has no verified electrical measurement capability.');

    const component = String(device.metadata?.component ?? (device.metadata?.channel === undefined ? '' : `em1:${device.metadata.channel}`));
    if (!/^(?:em1|switch):\d+$/.test(component)) {
      throw new ServiceUnavailableException('A verified electrical channel is not available.');
    }
    // The shared history service enforces the persisted source/field authority
    // and reads the canonical generic repository for every transport.
    const history = await this.measurements.history(
      { tenantId: tenant.id, siteId: site.id }, deviceId, metric, fromValue, toValue, maxHistoryRows,
    );
    const measured = history.measurements.filter(reading =>
      reading.quality === 'measured' && typeof reading.value === 'number' && Number.isFinite(reading.value),
    );
    const stride = Math.max(1, Math.ceil(measured.length / maxChartPoints));
    const points = measured.filter((_, index) => index % stride === 0 || index === measured.length - 1)
      .map(reading => ({ observedAt: reading.observedAt, value: reading.value, unit: reading.unit }));
    return { ...history, measurements: points };
  }
}
