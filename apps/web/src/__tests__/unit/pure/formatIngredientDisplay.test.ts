import { describe, it, expect } from 'vitest';
import { formatIngredientDisplay } from '@/shared/recipes/formatIngredientDisplay';

describe('formatIngredientDisplay', () => {
  it('visual pair + canonical gram → "<qty> <label> <name> (<qtyg>)"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 30,
        unit: 'gram',
        visual_quantity: 1,
        visual_unit_label: 'slice',
        productName: 'Bacon',
      }),
    ).toBe('1 slice Bacon (30g)');
  });

  it('visual pair + canonical container → "<qty> <label> <name> (<qty> ctn)"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'container',
        visual_quantity: 1,
        visual_unit_label: 'slice',
        productName: 'Bacon',
      }),
    ).toBe('1 slice Bacon (1 ctn)');
  });

  it('visual unset, gram → "<qty>g <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 30,
        unit: 'gram',
        visual_quantity: null,
        visual_unit_label: null,
        productName: 'Bacon',
      }),
    ).toBe('30g Bacon');
  });

  it('visual unset, container → "<qty> ctn <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'container',
        visual_quantity: null,
        visual_unit_label: null,
        productName: 'Bacon',
      }),
    ).toBe('1 ctn Bacon');
  });

  it('visual unset, serving → "<qty> svg <name>"', () => {
    expect(
      formatIngredientDisplay({
        quantity: 2,
        unit: 'serving',
        visual_quantity: null,
        visual_unit_label: null,
        productName: 'Bacon',
      }),
    ).toBe('2 svg Bacon');
  });

  it('tiny visual_quantity (0.5) renders correctly without trailing zeros', () => {
    expect(
      formatIngredientDisplay({
        quantity: 15,
        unit: 'gram',
        visual_quantity: 0.5,
        visual_unit_label: 'scoop',
        productName: 'Protein Powder',
      }),
    ).toBe('0.5 scoop Protein Powder (15g)');
  });

  it('empty product name handled gracefully', () => {
    expect(
      formatIngredientDisplay({
        quantity: 1,
        unit: 'serving',
        visual_quantity: null,
        visual_unit_label: null,
        productName: '',
      }),
    ).toBe('1 svg ');
  });
});
