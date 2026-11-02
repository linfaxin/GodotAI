import {readFileSync} from 'node:fs';
export default {
  entries:{app:'App.tsx'},
  nativeInterfaces:{endpoint:JSON.parse(readFileSync(new URL('./interface.json',import.meta.url),'utf8'))},
  verification:{entry:'verification.ts'},
  mode:'development',
};
