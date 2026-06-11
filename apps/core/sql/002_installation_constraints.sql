delete from installation_circuits a
using installation_circuits b
where a.panel_id = b.panel_id
  and a.circuit_no = b.circuit_no
  and a.created_at > b.created_at;

create unique index if not exists uq_installation_circuits_panel_circuit_no
  on installation_circuits(panel_id, circuit_no);
