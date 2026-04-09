export function buildExtractorPrompt(input: {
  message: string;
  draftSummary?: string;
}): string {
  return `
You extract structured estimator intent from a user message.

Return JSON ONLY.

Allowed actions:
- set_scope
- add_scope
- fill_missing_field
- ask_explanation
- unknown

Allowed entityType:
- point
- device
- panel

Allowed entityKind:
- power_point
- low_current_point
- socket_or_switch_concealed
- socket_or_switch_surface
- three_phase_socket
- bathroom_fan
- motion_sensor
- internet_outlet
- light_fixture_basic
- boiler_connection
- stove_connection
- ac_connection
- apartment_panel_up_to_4
- apartment_panel_up_to_8
- apartment_panel_above_8
- boiler_panel

Rules:
- boiler -> boiler_connection
- stove/печка -> stove_connection
- AC/климатик -> ac_connection
- do NOT invent pricing
- if unsure -> unknown

User message:
"${input.message}"
`;
}
