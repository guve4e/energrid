import { LocalExpenseTextExtractor } from './local-expense-text-extractor';

describe('LocalExpenseTextExtractor', () => {
  const extractor = new LocalExpenseTextExtractor();

  it.each([
    ['Похарчих 76 евро в Лидл.', '76', 'EUR', 'Lidl', 'Groceries'],
    ['Дадох 35 лева в Кауфланд.', '35', 'BGN', 'Kaufland', 'Groceries'],
    ['Платих 20 евро за бензин.', '20', 'EUR', null, 'Fuel'],
    ['Купих храна за кучетата за 18 евро.', '18', 'EUR', null, 'Pets'],
  ])('extracts Bulgarian expense: %s', async (text, amount, currency, merchantName, category) => {
    const proposal = await extractor.extract(text);
    expect(proposal).toMatchObject({ amount, currency, merchantName, category, description: text });
  });

  it('keeps missing currency and merchant ambiguous', async () => {
    const proposal = await extractor.extract('Похарчих 76 в магазина.');
    expect(proposal.amount).toBeNull();
    expect(proposal.currency).toBeNull();
    expect(proposal.merchantName).toBeNull();
  });

  it('recognizes symbol-prefixed EUR amounts', async () => {
    const proposal = await extractor.extract('I spent €76 at Lidl.');
    expect(proposal).toMatchObject({ amount: '76', currency: 'EUR', merchantName: 'Lidl' });
  });

  it('keeps the original merchant spelling in the spoken description', async () => {
    const text = 'Похарчих 76 евро в Лидл.';
    const proposal = await extractor.extract(text);
    expect(proposal.merchantName).toBe('Lidl');
    expect(proposal.description).toBe(text);
  });
});
