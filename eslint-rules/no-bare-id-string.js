/**
 * ESLint rule: no-bare-id-string
 *
 * In cross-process boundary files (emit handlers, outbox writers, payload
 * contracts, weight_sync), function parameters and object properties named
 * lot_id, product_id, event_id, or pi_lot_id must NOT use the bare `string`
 * type annotation. They must use a branded type (CloudLotId, PiLocalLotId,
 * CloudProductId, etc.) to prevent namespace-conflation bugs where a Pi-local
 * UUID is passed where a cloud UUID is expected (or vice versa).
 *
 * This rule applies to files matching the boundary patterns:
 *   - *emit*
 *   - *outbox*
 *   - *weight_sync*
 *   - *shelf-ingest*
 *   - *payload_contracts*
 *
 * Correct:
 *   function emitSync(pi_lot_id: CloudLotId): ...
 *   const payload: { pi_lot_id: CloudLotId } = ...
 *
 * Incorrect (flagged):
 *   function emitSync(pi_lot_id: string): ...
 *   const payload: { lot_id: string } = ...
 */

'use strict';

/** ID-like parameter/property names that must not be bare `string`. */
const SENSITIVE_NAMES = new Set(['lot_id', 'pi_lot_id', 'product_id', 'event_id', 'pi_event_id']);

/** Branded type names that satisfy the constraint. */
const BRANDED_TYPES = new Set(['CloudLotId', 'PiLocalLotId', 'CloudProductId', 'CloudEventId', 'PiLocalEventId']);

/**
 * Return true if the TSTypeAnnotation node is the bare `string` primitive.
 * We specifically want to flag `string` but not `string | null`, `string[]`,
 * template literals, etc. — callers should use the branded union if they
 * need nullability.
 */
function isBareString(typeAnnotation) {
  if (!typeAnnotation) return false;
  // typeAnnotation is the TSTypeAnnotation wrapper; the actual type is .typeAnnotation
  const inner = typeAnnotation.typeAnnotation ?? typeAnnotation;
  return inner.type === 'TSStringKeyword';
}

/**
 * Return true if the TSTypeAnnotation node resolves to one of the allowed
 * branded types (or a union that includes only branded types and null/undefined).
 */
function isBrandedType(typeAnnotation) {
  if (!typeAnnotation) return false;
  const inner = typeAnnotation.typeAnnotation ?? typeAnnotation;
  if (inner.type === 'TSTypeReference') {
    const name = inner.typeName?.name ?? inner.typeName?.right?.name ?? null;
    return BRANDED_TYPES.has(name);
  }
  // Allow TSUnionType whose members are all branded or null/undefined
  if (inner.type === 'TSUnionType') {
    return inner.types.every(
      (t) =>
        (t.type === 'TSTypeReference' && BRANDED_TYPES.has(t.typeName?.name ?? t.typeName?.right?.name ?? null)) ||
        t.type === 'TSNullKeyword' ||
        t.type === 'TSUndefinedKeyword',
    );
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require branded ID types instead of bare string in cross-process boundary files',
      category: 'Type safety',
      recommended: false,
    },
    schema: [],
    messages: {
      noBareIdString:
        "'{{name}}' in a cross-process boundary file must use a branded type " +
        '(CloudLotId, PiLocalLotId, CloudProductId, CloudEventId, ' +
        'PiLocalEventId) instead of bare `string`. ' +
        'Pass the value through the appropriate parse_* function first.',
    },
  },

  create(context) {
    /**
     * Check a single name+typeAnnotation pair. Reports if the name is
     * sensitive and the type is bare `string`.
     */
    function checkNamedType(name, typeAnnotation, reportNode) {
      if (!SENSITIVE_NAMES.has(name)) return;
      if (isBareString(typeAnnotation) && !isBrandedType(typeAnnotation)) {
        context.report({
          node: reportNode,
          messageId: 'noBareIdString',
          data: { name },
        });
      }
    }

    return {
      // Function parameter: function emit(pi_lot_id: string)
      'FunctionDeclaration > :matches(Identifier, RestElement)[typeAnnotation]'(node) {
        checkNamedType(node.name, node.typeAnnotation, node);
      },
      'FunctionExpression > :matches(Identifier, RestElement)[typeAnnotation]'(node) {
        checkNamedType(node.name, node.typeAnnotation, node);
      },
      'ArrowFunctionExpression > :matches(Identifier, RestElement)[typeAnnotation]'(node) {
        checkNamedType(node.name, node.typeAnnotation, node);
      },

      // TypeScript interface / type literal property: { lot_id: string }
      'TSPropertySignature[key.name]'(node) {
        const name = node.key?.name;
        if (!name) return;
        const typeAnnotation = node.typeAnnotation;
        checkNamedType(name, typeAnnotation, node);
      },

      // Object type in TSTypeAliasDeclaration member
      'TSTypeAliasDeclaration TSPropertySignature[key.name]'(node) {
        const name = node.key?.name;
        if (!name) return;
        checkNamedType(name, node.typeAnnotation, node);
      },
    };
  },
};
