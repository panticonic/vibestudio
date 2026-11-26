import path from 'node:path';
/** Relative callable-source owner of a service selector. Runtime declaration
 * files and generated NL declarations are not callable owners. */
export function authoredServiceScopeFile(selector){
 if(typeof selector!=='string')return null;
 const file=selector.endsWith('/**')?selector.slice(0,-3):selector;
 return /\.(?:nl|ts)$/u.test(file)&&!file.endsWith('.d.ts')&&!file.endsWith('.d.nl.ts')&&
  !path.isAbsolute(file)&&!file.startsWith('../')&&!file.includes('\\')&&path.posix.normalize(file)===file
  ?file:null;
}
