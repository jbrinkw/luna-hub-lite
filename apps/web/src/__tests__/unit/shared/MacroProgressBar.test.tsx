import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MacroProgressBar } from '@/components/shared/MacroProgressBar';

describe('MacroProgressBar', () => {
  it('renders label, current, goal, and percentage', () => {
    render(<MacroProgressBar label="Protein" current={75} goal={150} color="#4caf50" testId="protein-bar" />);
    const bar = screen.getByTestId('protein-bar');
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveTextContent('Protein');
    expect(bar).toHaveTextContent('75');
    expect(bar).toHaveTextContent('150');
    expect(bar).toHaveTextContent('50%');
  });

  it('caps percentage at 100%', () => {
    render(<MacroProgressBar label="Calories" current={2500} goal={2000} color="red" testId="cal-bar" />);
    expect(screen.getByTestId('cal-bar')).toHaveTextContent('100%');
  });

  it('shows 0% when goal is 0', () => {
    render(<MacroProgressBar label="Fat" current={10} goal={0} color="orange" testId="zero-bar" />);
    expect(screen.getByTestId('zero-bar')).toHaveTextContent('0%');
  });

  it('renders with unit suffix', () => {
    render(<MacroProgressBar label="Protein" current={50} goal={100} color="blue" unit="g" testId="unit-bar" />);
    expect(screen.getByTestId('unit-bar')).toHaveTextContent('50g / 100g');
  });

  it('renders without unit suffix when not provided', () => {
    render(<MacroProgressBar label="Cals" current={1000} goal={2000} color="red" testId="no-unit" />);
    expect(screen.getByTestId('no-unit')).toHaveTextContent('1000 / 2000');
  });

  it('renders fill bar with correct width style', () => {
    const { container } = render(
      <MacroProgressBar label="Carbs" current={125} goal={250} color="#2196f3" testId="width-bar" />,
    );
    const fillBar = container.querySelector<HTMLElement>('[style*="width: 50%"]');
    // Verify the element exists *and* that its inline width style is exactly
    // 50% — not just that some matching substring appeared somewhere.
    expect(fillBar).not.toBeNull();
    expect(fillBar!.style.width).toBe('50%');
  });

  it('applies the color to the fill bar', () => {
    const { container } = render(
      <MacroProgressBar label="Fat" current={30} goal={65} color="#ff9800" testId="color-bar" />,
    );
    // jsdom normalizes CSS color values, so check both hex and rgb() forms.
    const fillBar = container.querySelector<HTMLElement>('[style*="background"]');
    expect(fillBar).not.toBeNull();
    const bg = fillBar!.style.background;
    expect(bg === '#ff9800' || bg === 'rgb(255, 152, 0)').toBe(true);
  });
});
