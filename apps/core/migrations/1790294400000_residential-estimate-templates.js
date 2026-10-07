exports.up = (pgm) => {
  pgm.sql(`
    CREATE TABLE IF NOT EXISTS residential_estimate_templates (
      version text PRIMARY KEY,
      is_default boolean NOT NULL DEFAULT false,
      config jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS residential_estimate_templates_default
      ON residential_estimate_templates(is_default) WHERE is_default;
    INSERT INTO residential_estimate_templates(version, is_default, config)
    VALUES ('bg-basic-v1', true, '{
      "socketsPerRoom":3,"kitchenSockets":3,"corridorSockets":1,"bathroomSockets":1,
      "routeMin":3,"routeMax":6,"corridorCount":1,"bathroomCount":1,"terraceCount":0,
      "boiler":true,"oven":true,"hob":true,"washer":true,"dishwasher":true,"dryer":false,
      "defaultPanelCode":"panel_modern",
      "panelDescriptions":{
        "panel_modern":"Предвидено е табло с предпазители и защита, която изключва захранването при определени утечки на ток. Тя намалява риска от токов удар, но не го премахва напълно.",
        "panel_full_protection":"Предвидени са отделни защити за кръговете, защита от пренапрежение и контрол на напрежението. Те се подбират за конкретната инсталация и не премахват напълно риска от токов удар.",
        "panel_custom":"Таблото се уточнява по индивидуален проект. Каталожната цена за труда е начална; нужните защити и допълнителната работа се определят според инсталацията."
      }
    }'::jsonb) ON CONFLICT (version) DO NOTHING;
  `);
};
exports.down = (pgm) => { pgm.sql('DROP TABLE residential_estimate_templates;'); };
