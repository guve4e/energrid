import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA, SELF_DECLARED_DEPS_METADATA } from '@nestjs/common/constants';
import { AccessJwtGuard, RoleGuard } from '../auth/auth.guard';
import { PortalController } from './portal.controller';
import { PortalDeviceTelemetryController } from './portal-device-telemetry.controller';
import { PortalMqttDiagnosticsController } from './portal-mqtt-diagnostics.controller';
import { DevicesModule } from '../devices/devices.module';
import { ShellyOperationalCollectionService } from '../devices/integrations/shelly/shelly-operational-collection.service';

const admin = { user: { userId: 'admin', role: 'admin', email: 'admin@example.test' }, headers: {} } as never;
const anonymous = { headers: {} } as never;

function route(controller: object, name: string) {
  const method = (controller as Record<string, any>)[name];
  return { path: Reflect.getMetadata(PATH_METADATA, method), method: Reflect.getMetadata(METHOD_METADATA, method) };
}

describe('Portal controller boundary contracts', () => {
  it.each([PortalController, PortalDeviceTelemetryController, PortalMqttDiagnosticsController])(
    '%s retains class-level JWT and administrator role guards', (controller) => {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toEqual([AccessJwtGuard, RoleGuard]);
      expect(Reflect.getMetadata('energrid.auth.roles', controller)).toEqual(['admin']);
      expect(Reflect.getMetadata(PATH_METADATA, controller)).toEqual('portal');
    },
  );

  it('retains all moved HTTP and SSE endpoint paths', () => {
    const telemetry = PortalDeviceTelemetryController.prototype;
    const mqtt = PortalMqttDiagnosticsController.prototype;
    expect(route(telemetry, 'getDeviceObservations')).toMatchObject({ path: 'devices/:deviceId/observations' });
    expect(route(telemetry, 'getDeviceReadModel')).toMatchObject({ path: 'devices/:deviceId/read-model' });
    expect(route(telemetry, 'getDeviceMeasurementHistory')).toMatchObject({ path: 'devices/:deviceId/measurements' });
    expect(route(telemetry, 'getDeviceElectricalMeasurementHistory')).toMatchObject({ path: 'devices/:deviceId/electrical-measurements' });
    expect(route(telemetry, 'getDeviceFirmwareDiagnostics')).toMatchObject({ path: 'devices/:deviceId/firmware-diagnostics' });
    expect(route(telemetry, 'getDeviceHealthHistory')).toMatchObject({ path: 'device-health/history' });
    expect(route(mqtt, 'getKitchenMqttEvidenceStatus')).toMatchObject({ path: 'mqtt/evidence/:deviceId/status' });
    expect(route(mqtt, 'getMqttBus')).toMatchObject({ path: 'bus/mqtt' });
    expect(route(mqtt, 'streamMqttBus')).toMatchObject({ path: 'bus/mqtt/events' });
    expect(route(mqtt, 'publishMqtt')).toMatchObject({ path: 'bus/mqtt/publish' });
    expect(route(PortalController.prototype, 'getShellyHttpEm1Approval')).toMatchObject({
      path: 'devices/:deviceId/shelly-http-em1-approval',
    });
    expect(route(PortalController.prototype, 'approveShellyHttpEm1')).toMatchObject({
      path: 'devices/:deviceId/shelly-http-em1-approval',
    });
  });

  it('injects the Shelly approval service through the Portal module boundary', () => {
    const dependencies = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, PortalController) || [];
    expect(dependencies).toContainEqual({ index: 15, param: ShellyOperationalCollectionService });
    expect(Reflect.getMetadata('exports', DevicesModule)).toContain(ShellyOperationalCollectionService);
  });

  it('keeps EM1 approval endpoints administrator-only and delegates site scope', async () => {
    const approval = { endpoint: '192.0.2.20', sourceId: 'shelly-http-em1', selector: 'EM1.GetStatus?id=0' };
    const getHttpEm1PowerApproval = jest.fn().mockResolvedValue(approval);
    const approveHttpEm1Power = jest.fn().mockResolvedValue({ ...approval, approved: true });
    const controller = Object.assign(Object.create(PortalController.prototype), {
      deviceRegistry: { getSnapshot: () => ({ tenant: { id: 'tenant-a' }, site: { id: 'site-home' } }) },
      shellyOperational: { getHttpEm1PowerApproval, approveHttpEm1Power },
    }) as PortalController;

    await expect(controller.getShellyHttpEm1Approval('device:em1:0', admin)).resolves.toEqual(approval);
    expect(getHttpEm1PowerApproval).toHaveBeenCalledWith('tenant-a', 'site-home', 'device:em1:0');
    await expect(controller.getShellyHttpEm1Approval('device:em1:0', anonymous)).rejects.toThrow(UnauthorizedException);
    expect(getHttpEm1PowerApproval).toHaveBeenCalledTimes(1);

    await expect(controller.approveShellyHttpEm1('device:em1:0', {
      confirmedDeviceId: 'device:em1:0', approvedFields: ['power'], confirmedSourceId: approval.sourceId,
      confirmedSelector: approval.selector, confirmedEndpoint: approval.endpoint,
    }, admin)).resolves.toMatchObject({ approved: true });
    expect(approveHttpEm1Power).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-a', siteId: 'site-home', deviceId: 'device:em1:0', confirmedEndpoint: approval.endpoint,
    }));
    await expect(controller.approveShellyHttpEm1('device:em1:0', {}, anonymous)).rejects.toThrow(UnauthorizedException);
    expect(approveHttpEm1Power).toHaveBeenCalledTimes(1);
  });

  it('derives measurement scope from the registry and rejects anonymous calls', async () => {
    const current = jest.fn().mockResolvedValue({ fields: { temperature: { value: 21 } } });
    const registry = { getSnapshot: () => ({ tenant: { id: 'tenant-1' }, site: { id: 'site-lab' } }) };
    const controller = new PortalDeviceTelemetryController(registry as never, { current } as never, {} as never);
    await expect(controller.getDeviceObservations('device-1', admin)).resolves.toMatchObject({ fields: { temperature: { value: 21 } } });
    expect(current).toHaveBeenCalledWith({ tenantId: 'tenant-1', siteId: 'site-lab' }, 'device-1');
    await expect(controller.getDeviceObservations('device-1', anonymous)).rejects.toThrow(UnauthorizedException);
    expect(current).toHaveBeenCalledTimes(1);
  });

  it('rejects unapproved firmware diagnostics without querying hardware', async () => {
    const get = jest.fn();
    const registry = { getSnapshot: () => ({ tenant: { id: 'tenant-1' }, site: { id: 'site-lab' } }), getDevices: () => [] };
    const controller = new PortalDeviceTelemetryController(registry as never, {} as never, {} as never, { get } as never);
    await expect(controller.getDeviceFirmwareDiagnostics('unknown', admin)).rejects.toThrow(NotFoundException);
    expect(get).not.toHaveBeenCalled();
  });

  it('restricts MQTT evidence to the active site and an administrator', async () => {
    const getCaptureStatus = jest.fn().mockResolvedValue({ status: 'ready' });
    const controller = new PortalMqttDiagnosticsController(
      { getSnapshot: () => ({ tenant: { id: 'tenant-1' }, site: { id: 'site-lab' } }) } as never,
      {} as never,
      { getCaptureStatus } as never,
    );
    await expect(controller.getKitchenMqttEvidenceStatus('device-1', anonymous)).rejects.toThrow(UnauthorizedException);
    expect(getCaptureStatus).not.toHaveBeenCalled();
    await expect(controller.getKitchenMqttEvidenceStatus('device-1', admin)).resolves.toEqual({ status: 'ready' });
    expect(getCaptureStatus).toHaveBeenCalledWith({ tenantId: 'tenant-1', siteId: 'site-lab' }, 'device-1');
  });

  it('preserves MQTT publish delegation but requires the administrator', async () => {
    const publishDebugMessage = jest.fn().mockResolvedValue({ accepted: true });
    const controller = new PortalMqttDiagnosticsController(
      { getSnapshot: () => ({ tenant: { id: 'tenant-1' }, site: { id: 'site-lab' } }) } as never,
      { publishDebugMessage } as never,
      {} as never,
    );
    await expect(Promise.resolve().then(() => controller.publishMqtt({ topic: 'lab/debug', payload: 'hello' }, anonymous)))
      .rejects.toThrow(UnauthorizedException);
    expect(publishDebugMessage).not.toHaveBeenCalled();
    await expect(controller.publishMqtt({ topic: 'lab/debug', payload: 'hello' }, admin))
      .resolves.toEqual({ accepted: true });
    expect(publishDebugMessage).toHaveBeenCalledWith('lab/debug', 'hello');
  });
});
