// tsc and watch consumers always see the private scheduler build. The official
// reconciler is imported only by the isolated vendor entry used in build.mjs.
import type Reconciler from 'react-reconciler';
declare const require:(name:string)=>any;
declare const process:{env:{NODE_ENV?:string}};
const createReconciler:typeof Reconciler=(process.env.NODE_ENV==='production'?require('./reconciler.production.js'):require('./reconciler.development.js')).default;
export default createReconciler;
