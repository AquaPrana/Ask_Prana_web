/** Silent BackHandler for web (Expo's web build does not log on every subscribe). */
const noop = () => {};
const BackHandler = {
  exitApp: noop,
  addEventListener() {
    return { remove: noop };
  },
  removeEventListener: noop,
};
export default BackHandler;
