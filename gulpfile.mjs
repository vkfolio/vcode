/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
// Diagnostic: surface otherwise-swallowed async failures (gulp reports only "did not complete").
process.on('unhandledRejection', (e) => { console.error('=== UNHANDLED REJECTION ===\n', (e && e.stack) || e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('=== UNCAUGHT EXCEPTION ===\n', (e && e.stack) || e); process.exit(1); });

await import('./build/gulpfile.ts');
