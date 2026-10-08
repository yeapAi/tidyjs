import {
    ImportType,
    ParserResult
} from '../parser';

/**
 * Supprime les imports non utilisés du résultat du parser
 * @param parserResult Résultat du parser d'imports
 * @param unusedImports Liste des imports non utilisés
 * @returns Résultat du parser mis à jour
 */
export function removeUnusedImports(parserResult: ParserResult, unusedImports: string[]): ParserResult {
    if (!unusedImports.length) {
        return parserResult;
    }

    const updatedResult = { ...parserResult };

    updatedResult.groups = parserResult.groups
        .map((group) => {
            const updatedGroup = { ...group };

            updatedGroup.imports = group.imports
                .map((importItem) => {
                    // Create a copy of the import item
                    const updatedImport = { ...importItem };

                    // Filter out unused specifiers
                    if (updatedImport.specifiers && updatedImport.specifiers.length) {
                        updatedImport.specifiers = updatedImport.specifiers.filter((specifier) => {
                            const specName = typeof specifier === 'string' ? specifier : specifier.local;
                            return !unusedImports.includes(specName);
                        });
                    }

                    // Check if default import is unused
                    if (updatedImport.defaultImport && unusedImports.includes(updatedImport.defaultImport)) {
                        updatedImport.defaultImport = undefined;
                        // For default imports, remove the specifier that contains the default import name
                        updatedImport.specifiers = updatedImport.specifiers.filter((specifier) => {
                            const specName = typeof specifier === 'string' ? specifier : specifier.local;
                            return !unusedImports.includes(specName);
                        });
                    }

                    return updatedImport;
                })
                .filter((importItem) => {
                    // Remove the entire import if:
                    // 1. No specifiers left AND no default import
                    // 2. It's a side-effect import (no specifiers, no default) - keep these always
                    if (importItem.type === ImportType.SIDE_EFFECT) {
                        return true; // Always keep side-effect imports
                    }

                    const hasSpecifiers = importItem.specifiers && importItem.specifiers.length > 0;
                    const hasDefault = importItem.defaultImport;

                    return hasSpecifiers || hasDefault;
                });

            return updatedGroup;
        })
        .filter((group) => group.imports.length > 0); // Remove empty groups

    return updatedResult;
}
