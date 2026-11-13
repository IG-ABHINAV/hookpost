// The signed-in app's stylesheets. Imported by each layout under (app) except
// /auth, which has its own small sheet (auth/auth.scss): Next inlines a
// route's CSS into its HTML, so whatever the (app) root layout imported was
// inlined into the sign-up page too.
import '../global.scss';
import 'react-tooltip/dist/react-tooltip.css';
import '@copilotkit/react-ui/styles.css';

export {};
