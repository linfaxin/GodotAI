export interface TypeDiagnostic {file?:string;message:string;line?:number;column?:number;start?:number;length?:number;code:number;category:'error'|'warning'|'info'}
export interface CompletionDTO {name:string;kind:string;sortText:string;insertText?:string}
export interface HoverDTO {start:number;length:number;display:string;documentation:string}
