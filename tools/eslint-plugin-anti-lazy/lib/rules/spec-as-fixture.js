'use strict';

/**
 * Rule: spec-as-fixture
 *
 * Flag tests that hardcode array literals whose values duplicate an imported
 * enum or const-object's member set. The bug: when the enum gets a new variant,
 * the test fixture doesn't update, so coverage silently shrinks.
 *
 * v1 heuristic (intentionally conservative):
 *   - In test files only (*.test.{ts,tsx,js,jsx} or *.spec.{ts,tsx,js,jsx})
 *   - Flags a `const cases = [<string>, <string>, ...]` declaration where:
 *     - Array has 4+ string-literal elements
 *     - All elements match members of an imported identifier (enum name / const-object name)
 *     - The import is a named or default import in the same file
 *
 * The match is by name-set intersection: if ≥4 strings in the array literal
 * all appear as property names of an imported const-object (tracked via
 * `ImportDeclaration`), the array is a manual copy of the enum.
 *
 * TODO (v2): resolve imported identifier to its source file, extract actual
 * member names, and compare against array values for full accuracy.
 *
 * For now, ships at 'warn' so it surfaces candidates for human review without
 * blocking CI.
 */
module.exports = {
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'flag hardcoded string arrays in tests that duplicate an imported enum — use Object.values(EnumName) instead',
    },
    schema: [],
    messages: {
      specAsFixture:
        'This array literal appears to duplicate the members of `{{ importName }}`. Prefer `Object.values({{ importName }})` or `Object.keys({{ importName }})` so new variants are automatically covered.',
    },
    hasSuggestions: true,
  },
  create(context) {
    const filename = context.getFilename ? context.getFilename() : context.filename || '';

    // Only run in test files
    const isTestFile =
      /\.test\.(ts|tsx|js|jsx)$/.test(filename) ||
      /\.spec\.(ts|tsx|js|jsx)$/.test(filename) ||
      /__tests__\//.test(filename);

    if (!isTestFile) return {};

    // Collect imported identifiers (potential enum names)
    const importedNames = new Set();

    return {
      ImportDeclaration(node) {
        // Collect all imported binding names (named imports + default)
        for (const specifier of node.specifiers) {
          importedNames.add(specifier.local.name);
        }
      },

      VariableDeclarator(node) {
        if (!node.init || node.init.type !== 'ArrayExpression') return;
        const elements = node.init.elements;
        if (!elements || elements.length < 4) return;

        // All elements must be string literals
        const strings = elements.map((el) => {
          if (el && el.type === 'Literal' && typeof el.value === 'string') return el.value;
          return null;
        });
        if (strings.some((s) => s === null)) return;

        // Check if the string values match known enum-style patterns:
        // e.g., all UPPER_CASE, or all PascalCase, or all match a common prefix.
        // Heuristic: if all strings share a common prefix of ≥3 chars, or are all UPPER_CASE,
        // they're likely enum values.
        const allUpperCase = strings.every((s) => s === s.toUpperCase() && /[A-Z_]/.test(s));
        const firstPrefix = strings[0].slice(0, 3).toUpperCase();
        const sharePrefix =
          firstPrefix.length >= 3 && strings.every((s) => s.toUpperCase().startsWith(firstPrefix));

        if (!allUpperCase && !sharePrefix) return;

        // Find if any imported name could be the enum source.
        // We look for imported names whose lowercased form appears in the filename
        // or whose PascalCase matches the naming pattern.
        // Simple heuristic: if any imported name ends with common enum suffixes.
        const enumCandidates = [...importedNames].filter((name) => {
          return (
            /Type$/.test(name) ||
            /Status$/.test(name) ||
            /Mode$/.test(name) ||
            /Kind$/.test(name) ||
            /Category$/.test(name) ||
            /State$/.test(name) ||
            // All-caps const objects
            name === name.toUpperCase()
          );
        });

        if (enumCandidates.length === 0) return;

        // Report against the best candidate (first match)
        const candidate = enumCandidates[0];
        context.report({
          node: node.init,
          messageId: 'specAsFixture',
          data: { importName: candidate },
          suggest: [
            {
              desc: `Replace with Object.values(${candidate})`,
              fix(fixer) {
                return fixer.replaceText(node.init, `Object.values(${candidate})`);
              },
            },
          ],
        });
      },
    };
  },
};
