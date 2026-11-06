// Repository-only adapter for the Python installation smoke; no package code is loaded.
import {inspectNativeCopies} from './native-copies.mjs';
const [root,expected]=process.argv.slice(2);
console.log(JSON.stringify(await inspectNativeCopies(root,JSON.parse(expected))));
