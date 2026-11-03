import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { mount } from '@vue/test-utils';
import InvestigationReport from './InvestigationReport.vue';

describe('evidence-grounded report presentation', () => {
  it('shows a proposal without executing it until the operator clicks approval', async () => {
    const execute = vi.fn();
    const proposal = { id: 'proposal-1', action: 'inspect_http_headers', reason: 'Verify server identity', requiredEvidenceIds: [], requiresApproval: true, status: 'proposed' };
    const report = {
      investigationId: 'investigation-1', deviceId: 'device-1', provider: 'local', model: 'fixture',
      report: { summary: 'One candidate', findings: [], unknowns: ['Device identity'], nextSteps: [] },
      assessment: { hypotheses: [], proposals: [proposal] },
    };
    const wrapper = mount(InvestigationReport, { props: { model: {
      selectedAiReport: ref(report), aiActionRunning: ref({}), aiActionErrors: ref({}),
      aiActionResults: ref({}), executeInvestigationProposal: execute,
      aiEvidenceLabel: vi.fn(), aiConfidenceLabel: vi.fn(),
    } as any } });
    expect(wrapper.text()).toContain('Requires approval');
    expect(execute).not.toHaveBeenCalled();
    const approve = wrapper.findAll('button').find(button => button.text().includes('Approve and run'));
    expect(approve).toBeDefined();
    await approve!.trigger('click');
    expect(execute).toHaveBeenCalledWith(proposal);
  });
});
