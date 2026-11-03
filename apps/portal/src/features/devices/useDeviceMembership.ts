import { ref, type Ref } from 'vue';
import { authFetch } from '../../auth/auth-client';
import type { PortalState } from '../../portal-state';
import type { LifecycleDeviceRecord } from '../../components/discovery/network-endpoint-lifecycle';

export function useDeviceMembership(options: {
  apiBase: string;
  request?: typeof authFetch;
  accessToken: Ref<string>;
  state: Ref<PortalState | null>;
}) {
  const { apiBase, accessToken, state } = options;
  const request = options.request ?? authFetch;
  const enrolledDeviceKeys = ref<Set<string>>(new Set());
  const enrollmentStatuses = ref<Map<string, 'enrolled' | 'suspended' | 'retired'>>(new Map());
  const lifecycleEnrollmentRecords = ref<LifecycleDeviceRecord[]>([]);
  const enrollmentError = ref('');
  let generation = 0;
  async function loadEnrollmentMembership() {
    const revision = ++generation;
    const token = accessToken.value;
    const scope = state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null;
    const isCurrent = () => revision === generation && accessToken.value === token &&
      (state.value ? `${state.value.tenant.id}:${state.value.site.id}` : null) === scope;
    enrolledDeviceKeys.value = new Set();
    enrollmentStatuses.value = new Map();
    lifecycleEnrollmentRecords.value = [];
    enrollmentError.value = '';

    try {
      const response = await request(
        `${apiBase}/portal/devices/enrollments`,
        {
          headers: {
            Authorization: `Bearer ${accessToken.value}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Enrollment API returned ${response.status}`);
      }

      const payload: unknown = await response.json();

      if (
        !payload ||
        typeof payload !== 'object' ||
        !('enrollments' in payload) ||
        !Array.isArray(payload.enrollments)
      ) {
        throw new Error('Invalid enrollment response');
      }

      const keys = new Set<string>();
      const statuses = new Map<string, 'enrolled' | 'suspended' | 'retired'>();
      const lifecycleRecords: LifecycleDeviceRecord[] = [];

      for (const item of payload.enrollments) {
        if (
          !item ||
          typeof item !== 'object' ||
          typeof item.tenantId !== 'string' ||
          typeof item.siteId !== 'string' ||
          typeof item.deviceId !== 'string' ||
          !['enrolled', 'suspended', 'retired'].includes(item.status) ||
          ('physicalIdentityValues' in item && (!Array.isArray(item.physicalIdentityValues) || !item.physicalIdentityValues.every((value: unknown) => typeof value === 'string'))) ||
          ('ambiguousPhysicalIdentityValues' in item && (!Array.isArray(item.ambiguousPhysicalIdentityValues) || !item.ambiguousPhysicalIdentityValues.every((value: unknown) => typeof value === 'string'))) ||
          ('physicalAssignments' in item && (!Array.isArray(item.physicalAssignments) || !item.physicalAssignments.every((assignment: unknown) =>
            !!assignment && typeof assignment === 'object' && typeof (assignment as Record<string, unknown>).physicalDeviceId === 'string' &&
            (!('componentKey' in assignment) || typeof (assignment as Record<string, unknown>).componentKey === 'string'))))
        ) {
          throw new Error('Invalid enrollment record');
        }

        if (item.status === 'enrolled') {
          const key = JSON.stringify([
            item.tenantId,
            item.siteId,
            item.deviceId,
          ]);
          keys.add(key);
          statuses.set(key, 'enrolled');
          lifecycleRecords.push({
            id: item.deviceId,
            displayName: typeof item.displayName === 'string' ? item.displayName : item.deviceId,
            tenantId: item.tenantId,
            siteId: item.siteId,
            identityValues: Array.isArray(item.physicalIdentityValues) ? item.physicalIdentityValues as string[] : [],
            ambiguousIdentityValues: Array.isArray(item.ambiguousPhysicalIdentityValues) ? item.ambiguousPhysicalIdentityValues as string[] : [],
            physicalAssignments: Array.isArray(item.physicalAssignments) ? item.physicalAssignments as LifecycleDeviceRecord['physicalAssignments'] : [],
          });
        } else {
          statuses.set(JSON.stringify([item.tenantId, item.siteId, item.deviceId]), item.status);
        }
      }

      if (!isCurrent()) return;
      enrolledDeviceKeys.value = keys;
      enrollmentStatuses.value = statuses;
      lifecycleEnrollmentRecords.value = lifecycleRecords;
    } catch (error) {
      if (!isCurrent()) return;
      enrolledDeviceKeys.value = new Set();
      enrollmentStatuses.value = new Map();
      lifecycleEnrollmentRecords.value = [];
      enrollmentError.value =
        error instanceof Error
          ? error.message
          : 'Device enrollment unavailable';
    }
  }


  return { enrolledDeviceKeys, enrollmentStatuses, lifecycleEnrollmentRecords, enrollmentError, loadEnrollmentMembership };
}
