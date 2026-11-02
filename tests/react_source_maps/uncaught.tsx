import * as React from "react";

function Label({text}: {text:string}) { return text; }

const element = <Label text="uncaught source map probe"/>;
if (element.type !== Label) throw new Error("REACT_MAP_ELEMENT_FAILURE");

console.trace("REACT_MAP_UNCAUGHT_TRACE");
throw new Error("REACT_MAP_UNCAUGHT_AUTHOR_THROW");
