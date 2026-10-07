import { Pool } from 'pg';
import { CatalogRepository } from '../estimator/catalog.repository';
import { CatalogV2Service } from './catalog-v2.service';
import { EstimateIntakeService } from './estimate-intake.service';
import { EstimateQuestionService } from './estimate-question.service';
import { EstimateExplanationService } from './estimate-explanation.service';
import { EstimatorV2Service } from './estimator-v2.service';
import { BoilerStrategy } from './strategies/boiler.strategy';
import { StoveStrategy } from './strategies/stove.strategy';

// Explicit opt-in only: two paid extraction calls and SELECTs against the configured catalog.
// Synthetic text only; does not create projects, leads, estimates or observations.
const live = process.env.ESTIMATOR_LIVE_TEST === 'true' ? test : test.skip;
live('real extraction, catalog calculation and explanation agree', async () => {
  require('dotenv').config({ quiet: true });
  const pool = new Pool({ connectionTimeoutMillis: 5000, ssl: process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : false });
  try {
    const repository = new CatalogRepository(pool);
    const catalog = new CatalogV2Service(repository);
    const questions = new EstimateQuestionService();
    const service = new EstimatorV2Service(repository, new EstimateIntakeService(), questions, new EstimateExplanationService(), new BoilerStrategy(questions, catalog), new StoveStrategy(questions, catalog));
    const estimate = await service.step({ tenantSlug: 'energrid', message: 'Искам електрическо свързване на 2 печки. За всяка трябва нова линия от таблото по 5 метра, без къртене.' });
    expect(estimate.status).toBe('preview');
    expect(estimate.draft).toMatchObject({ jobType: 'stove_installation', quantity: 2, routeLengthMeters: 5, wallType: 'none', connectionMode: 'new_line_required' });
    expect(estimate.rangePreview?.lines.map(line => line.quantity)).toEqual([2, 4]);
    expect(estimate.rangePreview!.min).toBeGreaterThan(0);
    const explained = await service.step({ tenantSlug: 'energrid', message: 'Обясни как се получава цената.', draft: estimate.draft });
    expect(explained.rangePreview).toEqual(estimate.rangePreview);
  } finally { await pool.end(); }
}, 60000);
