import { Navigation, Script } from "scripting"
import Gallery from "./demo"

async function run() {
  await Navigation.present(<Gallery />)
  Script.exit()
}

run()
