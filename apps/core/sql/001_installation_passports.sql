create table if not exists installations (
  id uuid primary key,
  customer_name text not null,
  customer_phone text,
  property_address text not null,
  status text not null default 'draft',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists installation_panels (
  id uuid primary key,
  installation_id uuid not null references installations(id) on delete cascade,
  name text not null,
  location text,
  main_breaker text,
  grounding_type text not null default 'unknown',
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists installation_circuits (
  id uuid primary key,
  panel_id uuid not null references installation_panels(id) on delete cascade,
  circuit_no integer not null,
  label text not null,
  breaker_type text,
  breaker_amps integer,
  breaker_curve text,
  cable_type text,
  cable_mm2 numeric,
  rcd_group text,
  room text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists installation_service_entries (
  id uuid primary key,
  installation_id uuid not null references installations(id) on delete cascade,
  type text not null,
  date timestamptz not null default now(),
  title text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
