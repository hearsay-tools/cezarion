import { expect, it } from 'vitest';
import { reportTitle } from './report-title.ts';

it('names the same snapshot in browser and server consumers without a DOM', () => {
  expect(reportTitle({ name: 'quarterly.results.html', title: 'Published results' })).toBe('Published results');
  expect(reportTitle({ name: 'quarterly.results.html' })).toBe('quarterly.results');
  expect(reportTitle({ name: '.report', title: '' })).toBe('.report');
});
