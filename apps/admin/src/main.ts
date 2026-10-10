import { startApp } from "./app.ts";
import "./style.css";

const root = document.getElementById("app");
if (root) startApp(root);
